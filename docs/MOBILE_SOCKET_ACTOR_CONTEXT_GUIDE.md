# Mobile team guidance: chat socket actor-context issue

## Problem summary

When a user switches between a personal profile and a company profile, chat socket events can still leak across contexts. In practice, this means a message that belongs to the user context may appear in the company chat view on mobile, or vice versa.

This is primarily a backend socket-scoping problem. The server should only emit chat events to the correct actor context. Until the backend fix is fully rolled out and validated, the mobile app should follow the temporary mitigation steps below.

## What is happening

The app is currently using a shared socket connection for the authenticated user. If the active profile changes, the socket may still be delivering events that were emitted under the wrong actor scope.

The events most affected are:
- `new_message`
- `conversation_updated`
- `notification`

## Temporary mobile-side mitigation

### 1. Treat profile switching as a socket reset boundary
When the active profile changes between user and company:
- disconnect and reconnect the socket
- rejoin the relevant conversation room after reconnect
- refresh the conversation list and current chat state

Recommended flow:
1. Detect profile switch
2. Disconnect existing socket
3. Recreate socket with the new active profile context
4. Rejoin current conversation
5. Refetch conversations/messages

### 2. Ignore events that do not match the current profile context
When handling incoming socket events, validate the event payload before rendering it.

For example:
- If the current profile is a company, ignore user-scoped message events that contain a user-only target profile context
- If the current profile is a user, ignore company-scoped message events that are meant for a company context

Use payload fields such as:
- `target_profile_type`
- `target_company_id`
- `conversation_id`
- `sender_id`

### 3. Avoid showing cross-profile chat updates in the wrong screen
If the active profile is company, do not render a chat update that clearly belongs to the user profile flow.

If the active profile is user, do not render a chat update that clearly belongs to the company/profile flow.

### 4. Refresh the conversation list after profile switch
After switching profile, force a refresh of:
- conversations
- unread state
- current conversation messages

This reduces the chance of stale UI state showing the wrong message thread.

## Recommended client handling pattern

### On profile switch
- clear current view state
- disconnect socket
- create a new socket connection
- rejoin active conversation
- fetch conversations again

### On incoming socket message
Before rendering:
- check the active profile type
- check the target profile type from payload
- ignore mismatched events

## Example rules

### If current profile is COMPANY
Ignore events when:
- payload is clearly user-scoped and not meant for the company context
- conversation belongs to a non-company user flow

### If current profile is USER
Ignore events when:
- payload is clearly company-scoped and not meant for the user context

## Important note

These steps are a mitigation only. They reduce the visible bug on mobile, but the correct fix is backend-side actor-scoping of socket events.

## Suggested QA checklist

Mobile team should validate:
- user profile -> company profile switch does not show the previous profile’s message updates
- company profile -> user profile switch does not leak company chat events into user view
- reconnect after profile switch restores correct conversation state
- no duplicate or stale conversation rows appear after switch

## Recommended implementation note for app code

If possible, keep the mitigation centralized in one place:
- a single socket event handler
- a single profile-switch handler
- one shared message filtering utility

That makes it easier to remove the workaround once the backend fix is deployed.
