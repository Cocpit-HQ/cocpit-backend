# Socket Implementation Guide

## 1. High-Level Architecture

The new WebSocket architecture is designed for **scalability**, **security**, and **maintainability**.

### Key Components:

1.  **Socket Entry (`src/sockets/index.js`)**:
    *   Initializes the Socket.IO server.
    *   Configures CORS based on environment variables.
    *   Sets up the **Redis Adapter** to allow multiple backend instances to communicate.
    *   Applies **JWT Authentication middleware**.
    *   Registers event handlers.

2.  **Service Layer (`src/services/socket.service.js`)**:
    *   A singleton service used by **REST Controllers**.
    *   Decouples the API from the Socket.IO implementation.
    *   Provides methods like `notifyUser` and `notifyConversation`.
    *   **Rule:** Controllers never import `io` directly; they use `socketService`.

3.  **Handlers (`src/sockets/*.handler.js`)**:
    *   **Status Handler**: Manages online/offline status. Instead of broadcasting to everyone, it fetches friends/followers from the DB and notifies *only* them.
    *   **Chat Handler**: Manages real-time chat events (`joinConversation`, `typing`). It enforces DB-based security checks before allowing users to listen to conversation channels.

4.  **Redis Adapter**:
    *   Ensures that if User A is connected to Server 1 and User B is on Server 2, they can still communicate.
    *   Pub/Sub mechanism syncs events across instances.

---

## 2. Event Flow Diagrams

### A. Sending a Message (REST -> Socket)
1.  **Client** POSTs to `/api/conversations/message`.
2.  **Controller** (`social.controller.js`) saves message to DB.
3.  **Controller** calls `socketService.notifyUser(targetId, 'newMessage', payload)`.
4.  **SocketService** finds the room `user_{targetId}`.
5.  **Socket.IO** emits the event to the specific client.

### B. Typing Indicator (Socket -> Socket)
1.  **Client** emits `typing` with `{ conversationId }`.
2.  **Chat Handler** receives the event.
3.  **Socket.IO** broadcasts `isTyping` to `conversation_{conversationId}` (excluding sender).
4.  **Other Clients** in the room receive the event.

### C. Connection/Presence
1.  **Client** connects with JWT.
2.  **Status Handler** runs `handleConnection`.
3.  **DB Query**: Fetches IDs of friends and followers.
4.  **SocketService** iterates and emits `userStatusChanged` to each friend's personal room.

---

## 3. Redis Role & Scaling

*   **Role**: Redis acts as the "glue" between server instances.
*   **Mechanism**: It uses Redis Pub/Sub. When Server A emits an event to `user_123`, if `user_123` is connected to Server B, the adapter publishes the event to Redis, Server B subscribes, receives it, and delivers it to the client.
*   **Requirement**: Set `REDIS_URL` in your environment (e.g., `redis://localhost:6379`).
*   **Fallback**: If Redis is not configured, the server defaults to in-memory mode (ok for single-instance dev, bad for production scaling).

---

## 4. Security Considerations

1.  **Token Validation**:
    *   The socket middleware strictly validates the JWT access token.
    *   Invalid tokens result in immediate disconnection.
2.  **Room Authorization**:
    *   **Old Way**: Client says "Join Room X", Server says "OK". (Insecure)
    *   **New Way**: Client says "Join Room X", Server checks `conversation_participants` table. If user is not a participant, the request is ignored or rejected.
3.  **Room Naming**:
    *   Room names are centralized in `src/utils/socketRooms.js` to prevent typos and spoofing.
4.  **Data Scoping**:
    *   Presence updates are no longer global broadcasts (O(N^2) traffic). They are targeted O(K) where K = connection count.

---

## 5. Postman Testing Guide

Since `npm test` is not set up, use Postman's WebSocket support to verify functionality.

### Prerequisite: Authentication
1.  Login via standard API (`POST /api/auth/login`) to get an **Access Token**.

### Test 1: Connect & Auth
1.  Open Postman -> New -> **WebSocket Request**.
2.  Enter URL: `ws://cocpit-backend-staging.up.railway.app` (or your port).
3.  Go to **Headers** or **Params**:
    *   Key: `Authorization`
    *   Value: `Bearer <YOUR_ACCESS_TOKEN>`
    *   *Alternative*: Some clients verify via `auth` object in handshake. If headers don't work, try adding the token to the Handshake Payload (if your client supports it) or simply ensure the client sends it in the `auth` field (Socket.IO client standard).
    *   *Note*: The server implementation looks for `socket.handshake.auth.token` OR `socket.handshake.headers.authorization`.
4.  Click **Connect**.
5.  **Expect**: "Connected" status.
6.  **Debug**: If it disconnects immediately, check server logs for "Socket auth error".

### Test 2: Receive Presence Updates
1.  Connect **Client A** (User A).
2.  Connect **Client B** (User B, who is a friend of A).
3.  Disconnect Client A.
4.  **Expect**: Client B receives event `userStatusChanged`:
    ```json
    {
      "userId": "<User_A_ID>",
      "status": "offline"
    }
    ```
5.  Reconnect Client A.
6.  **Expect**: Client B receives `userStatusChanged` with status `online`.

### Test 3: Chat Flow (Typing)
1.  **Client A** and **Client B** are in a conversation (ID: `conv_123`).
2.  **Client A** emits:
    *   Event: `joinConversation`
    *   Message (Text/JSON): `"conv_123"` (Ensure quotes if sending as string, or standard JSON arg).
3.  **Client B** joins similarly.
4.  **Client A** emits `typing`:
    *   Message: `{"conversationId": "conv_123"}`
5.  **Client B** should receive event `isTyping`:
    ```json
    {
      "senderId": "<User_A_ID>",
      "conversationId": "conv_123"
    }
    ```

### Test 4: Receive New Message
1.  Keep **Client B** connected.
2.  Use standard Postman HTTP Request to send a message from **User A** to **User B**.
    *   `POST /api/conversations/message`
    *   Body: `{ "targetUserId": "<User_B_ID>", "text_content": "Hello Socket" }`
3.  **Client B** (WebSocket) should receive `newMessage`:
    ```json
    {
      "message_id": "...",
      "text_content": "Hello Socket",
      ...
    }
    ```
    And `notification` event.

---

## 6. Debugging & Common Failures

| Issue | Probable Cause | Fix |
| :--- | :--- | :--- |
| **Connection Refused** | Server not running or wrong port. | Check `npm run dev` output. |
| **Immediate Disconnect** | Invalid/Expired JWT. | Get a new token via `/api/auth/login`. |
| **No "Typing" Events** | User didn't join the room. | Emit `joinConversation` with valid ID first. |
| **Redis Error Logs** | Redis not running. | Start Redis or ignore (fallback to memory). |
| **Cross-User Updates Missing** | Users not "connected" in DB. | Check `connections` table. |
