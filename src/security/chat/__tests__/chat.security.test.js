const chatSecurity = require('../chat.security');
const AppError = require('../../../core/errors/AppError');

describe('Chat Security Guard & Validator Suite', () => {
  describe('Emoji Validation (sanitizeReactionEmoji)', () => {
    test('accepts standard single emoji', () => {
      expect(chatSecurity.sanitizeReactionEmoji('🔥')).toBe('🔥');
      expect(chatSecurity.sanitizeReactionEmoji('👍')).toBe('👍');
      expect(chatSecurity.sanitizeReactionEmoji('❤️')).toBe('❤️');
    });

    test('accepts empty string to clear a reaction', () => {
      expect(chatSecurity.sanitizeReactionEmoji('')).toBe('');
      expect(chatSecurity.sanitizeReactionEmoji('   ')).toBe('');
      expect(chatSecurity.sanitizeReactionEmoji(null)).toBe('');
    });

    test('rejects arbitrary non-emoji text', () => {
      expect(() => chatSecurity.sanitizeReactionEmoji('hello')).toThrow(AppError);
      expect(() => chatSecurity.sanitizeReactionEmoji('script<alert>')).toThrow(AppError);
    });

    test('rejects strings exceeding 8 characters', () => {
      expect(() => chatSecurity.sanitizeReactionEmoji('🔥'.repeat(10))).toThrow(AppError);
    });
  });

  describe('Message Content Validation (validateMessageContent)', () => {
    test('accepts valid text content within limits', () => {
      expect(chatSecurity.validateMessageContent('Hello world')).toBe('Hello world');
    });

    test('rejects empty text', () => {
      expect(() => chatSecurity.validateMessageContent('')).toThrow(AppError);
      expect(() => chatSecurity.validateMessageContent('   ')).toThrow(AppError);
    });

    test('rejects content exceeding maximum length', () => {
      const longText = 'a'.repeat(5001);
      expect(() => chatSecurity.validateMessageContent(longText, 5000)).toThrow(AppError);
    });
  });

  describe('Chat Request Recipient Guard (assertChatRequestRecipient)', () => {
    test('throws 404 when conversation does not exist', async () => {
      const mockDb = {
        query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      };

      await expect(
        chatSecurity.assertChatRequestRecipient('conv-1', 'user-1', mockDb)
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    test('throws 403 when caller is not a participant', async () => {
      const mockDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [{ conversation_id: 'conv-1', is_requesting: true, created_by: 'user-creator' }],
          })
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }), // not in conversation_participants
      };

      await expect(
        chatSecurity.assertChatRequestRecipient('conv-1', 'user-outsider', mockDb)
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    test('throws 400 when conversation is not in requesting state', async () => {
      const mockDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [{ conversation_id: 'conv-1', is_requesting: false, created_by: 'user-creator' }],
          })
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [{ participant_id: 'p-1', user_id: 'user-recipient' }],
          }),
      };

      await expect(
        chatSecurity.assertChatRequestRecipient('conv-1', 'user-recipient', mockDb)
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    test('throws 400 when sender tries to accept or decline their own request', async () => {
      const mockDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [{ conversation_id: 'conv-1', is_requesting: true, created_by: 'user-sender' }],
          })
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [{ participant_id: 'p-1', user_id: 'user-sender' }],
          }),
      };

      await expect(
        chatSecurity.assertChatRequestRecipient('conv-1', 'user-sender', mockDb)
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    test('succeeds when caller is the genuine recipient participant', async () => {
      const mockDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [{ conversation_id: 'conv-1', is_requesting: true, created_by: 'user-sender' }],
          })
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [{ participant_id: 'p-recipient', user_id: 'user-recipient' }],
          }),
      };

      const result = await chatSecurity.assertChatRequestRecipient(
        'conv-1',
        'user-recipient',
        mockDb
      );
      expect(result.conversation.conversation_id).toBe('conv-1');
      expect(result.participant.participant_id).toBe('p-recipient');
    });
  });

  describe('Conversation Participant Guard (assertConversationParticipant)', () => {
    test('throws 403 when user is not in conversation_participants', async () => {
      const mockDb = {
        query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      };

      await expect(
        chatSecurity.assertConversationParticipant('conv-1', 'user-nonparticipant', mockDb)
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    test('succeeds when user is an active participant', async () => {
      const mockDb = {
        query: jest.fn().mockResolvedValue({
          rowCount: 1,
          rows: [{ participant_id: 'p-1', conversation_id: 'conv-1', user_id: 'user-1' }],
        }),
      };

      const res = await chatSecurity.assertConversationParticipant('conv-1', 'user-1', mockDb);
      expect(res.participant_id).toBe('p-1');
    });
  });

  describe('File Magic Bytes Validation (validateFileMagicBytes - VULN-07)', () => {
    test('accepts valid PNG magic bytes', () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
      const res = chatSecurity.validateFileMagicBytes(pngHeader, 'image/png');
      expect(res.verified).toBe(true);
      expect(res.detectedExt).toBe('.png');
    });

    test('accepts valid JPEG magic bytes', () => {
      const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const res = chatSecurity.validateFileMagicBytes(jpegHeader, 'image/jpeg');
      expect(res.verified).toBe(true);
      expect(res.detectedExt).toBe('.jpg');
    });

    test('accepts valid PDF magic bytes', () => {
      const pdfHeader = Buffer.from('%PDF-1.4\n%...');
      const res = chatSecurity.validateFileMagicBytes(pdfHeader, 'application/pdf');
      expect(res.verified).toBe(true);
      expect(res.detectedExt).toBe('.pdf');
    });

    test('rejects HTML disguised as image (MIME spoofing XSS attempt)', () => {
      const maliciousHtml = Buffer.from('<html><script>alert(1)</script></html>');
      expect(() => {
        chatSecurity.validateFileMagicBytes(maliciousHtml, 'image/png');
      }).toThrow(AppError);
    });

    test('rejects mismatched file signature (e.g. text file declared as PNG)', () => {
      const textBuffer = Buffer.from('Just plain text content');
      expect(() => {
        chatSecurity.validateFileMagicBytes(textBuffer, 'image/png');
      }).toThrow(AppError);
    });
  });

  describe('CORS Origin Validation (isOriginAllowed - VULN-08)', () => {
    test('allows same-origin / server-to-server (origin is null/empty)', () => {
      expect(chatSecurity.isOriginAllowed(null)).toBe(true);
      expect(chatSecurity.isOriginAllowed(undefined)).toBe(true);
    });

    test('allows official production domains in production', () => {
      expect(
        chatSecurity.isOriginAllowed('https://frontend.cocpit.in', { nodeEnv: 'production' })
      ).toBe(true);
      expect(
        chatSecurity.isOriginAllowed('https://staging.cocpit.in', { nodeEnv: 'production' })
      ).toBe(true);
      expect(chatSecurity.isOriginAllowed('https://uat.cocpit.in', { nodeEnv: 'production' })).toBe(
        true
      );
    });

    test('allows localhost in development', () => {
      expect(
        chatSecurity.isOriginAllowed('http://localhost:3000', { nodeEnv: 'development' })
      ).toBe(true);
      expect(
        chatSecurity.isOriginAllowed('http://127.0.0.1:5173', { nodeEnv: 'development' })
      ).toBe(true);
    });

    test('allows ngrok tunnels in development', () => {
      expect(
        chatSecurity.isOriginAllowed('https://my-tunnel.ngrok-free.app', { nodeEnv: 'development' })
      ).toBe(true);
    });

    test('BLOCKS arbitrary ngrok tunnels in production', () => {
      expect(
        chatSecurity.isOriginAllowed('https://attacker.ngrok-free.app', { nodeEnv: 'production' })
      ).toBe(false);
      expect(
        chatSecurity.isOriginAllowed('https://attacker.loca.lt', { nodeEnv: 'production' })
      ).toBe(false);
    });

    test('BLOCKS arbitrary untrusted origins in production', () => {
      expect(chatSecurity.isOriginAllowed('https://evil-site.com', { nodeEnv: 'production' })).toBe(
        false
      );
    });
  });
});
