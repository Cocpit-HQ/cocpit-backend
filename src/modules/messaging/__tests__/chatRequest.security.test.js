const groupChatController = require("../groupChat.controller");
const pool = require("../../../core/db/pool");

jest.mock("../../../core/db/pool", () => ({
    query: jest.fn(),
}));

describe("VULN-10: Chat Request Accept/Decline Security Verification", () => {
    let req, res;

    beforeEach(() => {
        jest.clearAllMocks();
        req = {
            user: { sub: "recipient-user-123" },
            params: { conversationId: "conv-uuid-456" }
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
    });

    describe("acceptChatRequest", () => {
        test("blocks third-party non-participant (returns 403 Forbidden)", async () => {
            req.user.sub = "outsider-attacker-999";

            // Mock: conversation exists, but outsider is not in conversation_participants
            pool.query
                .mockResolvedValueOnce({
                    rowCount: 1,
                    rows: [{ conversation_id: "conv-uuid-456", is_active: true, is_requesting: true, created_by: "initiator-user" }]
                })
                .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // outsider not in participants

            await groupChatController.acceptChatRequest(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining("Forbidden")
            }));
        });

        test("blocks sender from force-accepting their own request (returns 400 Bad Request)", async () => {
            req.user.sub = "initiator-user"; // Creator tries to accept

            pool.query
                .mockResolvedValueOnce({
                    rowCount: 1,
                    rows: [{ conversation_id: "conv-uuid-456", is_active: true, is_requesting: true, created_by: "initiator-user" }]
                })
                .mockResolvedValueOnce({
                    rowCount: 1,
                    rows: [{ participant_id: "p-sender", user_id: "initiator-user" }]
                });

            await groupChatController.acceptChatRequest(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining("Only the recipient can accept or decline")
            }));
        });

        test("allows genuine recipient to accept pending chat request (returns 200 OK)", async () => {
            req.user.sub = "recipient-user-123";

            pool.query
                .mockResolvedValueOnce({
                    rowCount: 1,
                    rows: [{ conversation_id: "conv-uuid-456", is_active: true, is_requesting: true, created_by: "initiator-user" }]
                })
                .mockResolvedValueOnce({
                    rowCount: 1,
                    rows: [{ participant_id: "p-recip", user_id: "recipient-user-123" }]
                })
                .mockResolvedValueOnce({
                    rowCount: 1,
                    rows: [{ conversation_id: "conv-uuid-456", is_requesting: false }]
                });

            await groupChatController.acceptChatRequest(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                message: "Chat request accepted"
            }));
        });
    });

    describe("declineChatRequest", () => {
        test("blocks third-party non-participant (returns 403 Forbidden)", async () => {
            req.user.sub = "outsider-attacker-999";

            pool.query
                .mockResolvedValueOnce({
                    rowCount: 1,
                    rows: [{ conversation_id: "conv-uuid-456", is_active: true, is_requesting: true, created_by: "initiator-user" }]
                })
                .mockResolvedValueOnce({ rowCount: 0, rows: [] });

            await groupChatController.declineChatRequest(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining("Forbidden")
            }));
        });

        test("allows genuine recipient to decline pending chat request (returns 200 OK)", async () => {
            req.user.sub = "recipient-user-123";

            pool.query
                .mockResolvedValueOnce({
                    rowCount: 1,
                    rows: [{ conversation_id: "conv-uuid-456", is_active: true, is_requesting: true, created_by: "initiator-user" }]
                })
                .mockResolvedValueOnce({
                    rowCount: 1,
                    rows: [{ participant_id: "p-recip", user_id: "recipient-user-123" }]
                })
                .mockResolvedValueOnce({ rowCount: 1 }) // soft delete
                .mockResolvedValueOnce({
                    rowCount: 1,
                    rows: [{ conversation_id: "conv-uuid-456" }]
                });

            await groupChatController.declineChatRequest(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                message: "Chat request declined"
            }));
        });
    });
});
