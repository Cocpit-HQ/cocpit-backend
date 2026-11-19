jest.mock("../../../core/cache/redis", () => ({
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    on: jest.fn(),
    quit: jest.fn(),
    status: "ready",
}));

jest.mock("../../../core/db/redis", () => ({
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    on: jest.fn(),
    quit: jest.fn(),
    status: "ready",
}));

const messageController = require("../message.controller");
const socialController = require("../../social/social.controller");
const pool = require("../../../core/db/pool");
const chatSecurity = require("../../../security/chat");

jest.mock("../../../core/db/pool", () => {
    const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
    };
    return {
        connect: jest.fn().mockResolvedValue(mockClient),
        query: jest.fn(),
        _mockClient: mockClient,
    };
});

describe("Phase 3: Message Deletion & Reactions Security (VULN-04 & VULN-05)", () => {
    let req, res, mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = pool._mockClient;
        req = {
            user: { sub: "test-user-123" },
            params: {},
            body: {}
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
    });

    describe("VULN-04: deleteMessage (Delete For Me)", () => {
        test("blocks non-participant from deleting a message (returns 403 Forbidden)", async () => {
            req.params = { messageId: "msg-999" };
            req.body = { deleteForEveryone: false };

            // 1. BEGIN
            mockClient.query.mockResolvedValueOnce({ rowCount: 0 });
            // 2. SELECT * FROM messages
            mockClient.query.mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ message_id: "msg-999", conversation_id: "conv-private", sender_id: "other-user" }]
            });
            // 3. assertConversationParticipant (query conversation_participants) -> 0 rows (not participant)
            mockClient.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
            // 4. ROLLBACK
            mockClient.query.mockResolvedValueOnce({ rowCount: 0 });

            await messageController.deleteMessage(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining("Forbidden")
            }));
        });

        test("allows active participant to delete for me (returns 200 OK)", async () => {
            req.params = { messageId: "msg-999" };
            req.body = { deleteForEveryone: false };

            mockClient.query.mockResolvedValueOnce({ rowCount: 0 }); // BEGIN
            mockClient.query.mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ message_id: "msg-999", conversation_id: "conv-allowed", sender_id: "other-user" }]
            }); // message
            mockClient.query.mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ participant_id: "p-1", conversation_id: "conv-allowed", user_id: "test-user-123" }]
            }); // participant check
            mockClient.query.mockResolvedValueOnce({ rowCount: 1 }); // INSERT INTO message_delete
            mockClient.query.mockResolvedValueOnce({ rowCount: 0 }); // COMMIT

            await messageController.deleteMessage(req, res);

            expect(res.status).not.toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                message: "Message deleted"
            }));
        });
    });

    describe("VULN-05: upsertReaction", () => {
        test("blocks non-participant from reacting to a message (returns 403 Forbidden)", async () => {
            req.params = { messageId: "msg-target" };
            req.body = { emoji: "👍" };

            // 1. SELECT conversation_id, sender_id, text_content FROM messages
            pool.query.mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ conversation_id: "conv-target", sender_id: "sender-1", text_content: "Hello" }]
            });
            // 2. assertConversationParticipant -> 0 rows (non-participant)
            pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

            await socialController.upsertReaction(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining("Forbidden")
            }));
        });

        test("rejects invalid non-emoji or oversized payload (returns 400 Bad Request)", async () => {
            req.params = { messageId: "msg-target" };
            req.body = { emoji: "A".repeat(500) }; // 500 characters spam

            pool.query.mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ conversation_id: "conv-target", sender_id: "sender-1", text_content: "Hello" }]
            });
            // Participant check passes
            pool.query.mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ participant_id: "p-1", user_id: "test-user-123" }]
            });

            await socialController.upsertReaction(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining("Invalid emoji")
            }));
        });
    });
});
