jest.mock("../../../core/db/pool", () => ({
    query: jest.fn(),
    connect: jest.fn(() => ({
        query: jest.fn(),
        release: jest.fn(),
    })),
    on: jest.fn(),
}));

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

const chatSecurity = require("../../../security/chat");
const socialController = require("../social.controller");

jest.mock("../../../security/chat", () => {
    const actual = jest.requireActual("../../../security/chat");
    return {
        ...actual,
        assertOrgMembership: jest.fn(),
    };
});

describe("Phase 2: Organization Chat Security (CHAT-001, CHAT-002, VULN-12, VULN-15)", () => {
    let req, res;

    beforeEach(() => {
        jest.clearAllMocks();
        req = {
            user: { sub: "attacker-user-id" },
            params: {},
            query: {},
            body: {},
            headers: {}
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
            setHeader: jest.fn(),
        };
    });

    describe("CHAT-001: sendMessage with unverified authorCompanyId", () => {
        test("blocks message creation and returns 403 when user is not member of authorCompanyId", async () => {
            req.body = {
                targetUserId: "victim-user",
                authorCompanyId: "unowned-company-uuid",
                text_content: "Impersonated phishing message"
            };

            const authErr = new Error("Forbidden: You are not an active member of this organization");
            authErr.statusCode = 403;
            chatSecurity.assertOrgMembership.mockRejectedValue(authErr);

            await socialController.sendMessage(req, res);

            expect(chatSecurity.assertOrgMembership).toHaveBeenCalledWith(
                "unowned-company-uuid",
                "attacker-user-id",
                expect.anything()
            );
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining("Forbidden")
            }));
        });
    });

    describe("CHAT-002: getConversations & getMessages Org Read IDOR", () => {
        test("getConversations blocks unauthorized query for target companyId", async () => {
            req.query = { companyId: "competitor-org-uuid" };

            const authErr = new Error("Forbidden: You are not an active member of this organization");
            authErr.statusCode = 403;
            chatSecurity.assertOrgMembership.mockRejectedValue(authErr);

            await socialController.getConversations(req, res);

            expect(chatSecurity.assertOrgMembership).toHaveBeenCalledWith(
                "competitor-org-uuid",
                "attacker-user-id",
                expect.anything()
            );
            expect(res.status).toHaveBeenCalledWith(403);
        });

        test("getMessages blocks unauthorized message history retrieval for target companyId", async () => {
            req.params = { id: "conv-uuid-123" };
            req.query = { companyId: "competitor-org-uuid" };

            const authErr = new Error("Forbidden: You are not an active member of this organization");
            authErr.statusCode = 403;
            chatSecurity.assertOrgMembership.mockRejectedValue(authErr);

            await socialController.getMessages(req, res);

            expect(chatSecurity.assertOrgMembership).toHaveBeenCalledWith(
                "competitor-org-uuid",
                "attacker-user-id",
                expect.anything()
            );
            expect(res.status).toHaveBeenCalledWith(403);
        });
    });

    describe("VULN-12: deleteConversation Org IDOR", () => {
        test("blocks deleting an organization's conversation when caller is not a member", async () => {
            req.params = { id: "conv-uuid-123" };
            req.query = { companyId: "target-org-uuid" };

            const authErr = new Error("Forbidden: You are not an active member of this organization");
            authErr.statusCode = 403;
            chatSecurity.assertOrgMembership.mockRejectedValue(authErr);

            await socialController.deleteConversation(req, res);

            expect(chatSecurity.assertOrgMembership).toHaveBeenCalledWith(
                "target-org-uuid",
                "attacker-user-id",
                expect.anything()
            );
            expect(res.status).toHaveBeenCalledWith(403);
        });
    });

    describe("VULN-15: togglePinMessage Org IDOR", () => {
        test("blocks pinning message on behalf of target company when caller is not a member", async () => {
            req.params = { conversationId: "conv-uuid-123" };
            req.body = { messageId: "msg-456", pinned: true, companyId: "target-org-uuid" };

            const authErr = new Error("Forbidden: You are not an active member of this organization");
            authErr.statusCode = 403;
            chatSecurity.assertOrgMembership.mockRejectedValue(authErr);

            await socialController.togglePinMessage(req, res);

            expect(chatSecurity.assertOrgMembership).toHaveBeenCalledWith(
                "target-org-uuid",
                "attacker-user-id",
                expect.anything()
            );
            expect(res.status).toHaveBeenCalledWith(403);
        });
    });
});
