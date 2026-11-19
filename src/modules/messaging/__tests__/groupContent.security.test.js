const groupChatController = require("../groupChat.controller");
const GroupChatService = require("../../../services/groupChat.service");

jest.mock("../../../services/groupChat.service");

describe("VULN-11 & VULN-06: Group IDOR Security Verification", () => {
    let req, res;

    beforeEach(() => {
        jest.clearAllMocks();
        req = {
            user: { sub: "user-123" },
            params: { groupId: "group-456" }
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
    });

    describe("VULN-11: getGroupSharedContent", () => {
        test("returns 403 Forbidden when user is not a participant of the group", async () => {
            const forbiddenErr = new Error("Forbidden: You are not an active member of this group");
            forbiddenErr.statusCode = 403;
            GroupChatService.getGroupSharedContent.mockRejectedValue(forbiddenErr);

            await groupChatController.getGroupSharedContent(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining("Forbidden")
            }));
        });

        test("returns 200 OK with shared media, posts, and links for active members", async () => {
            const mockSharedData = {
                media: [{ media_id: "m-1", url: "https://r2.dev/img.jpg" }],
                posts: [],
                links: []
            };
            GroupChatService.getGroupSharedContent.mockResolvedValue(mockSharedData);

            await groupChatController.getGroupSharedContent(req, res);

            expect(res.status).not.toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(mockSharedData);
        });
    });

    describe("VULN-06: getGroupDetails", () => {
        test("returns 403 Forbidden when non-member requests private group details", async () => {
            const forbiddenErr = new Error("Forbidden: You are not an active member of this group.");
            forbiddenErr.statusCode = 403;
            GroupChatService.getGroupDetails.mockRejectedValue(forbiddenErr);

            await groupChatController.getGroupDetails(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining("Forbidden")
            }));
        });

        test("returns 200 OK with full group details for active members", async () => {
            const mockGroupDetails = {
                conversation_id: "group-456",
                conversation_name: "Executive Team",
                members: [{ user_id: "user-123", full_name: "Member A" }]
            };
            GroupChatService.getGroupDetails.mockResolvedValue(mockGroupDetails);

            await groupChatController.getGroupDetails(req, res);

            expect(res.status).not.toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(mockGroupDetails);
        });
    });
});
