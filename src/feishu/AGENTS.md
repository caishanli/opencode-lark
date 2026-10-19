# feishu/

All direct Feishu platform I/O: REST API calls, WebSocket connection to Open Platform, card building, and the webhook server for card callbacks.

## Files

### `api-client.ts`
Thin wrapper around Feishu's REST API. Handles token refresh automatically.

Critical response structure gotcha: `getBotInfo()` calls `/bot/v3/info`, and the bot object sits at the **top level of the response**, not under `data`. Accessing `response.data.bot` will return `undefined`. The correct path is `response.bot`.

Other key methods:
- `uploadImage(imageData, imageType?)` — uploads to Feishu's image store, returns an `image_key`. `imageType` defaults to `"message"`
- `uploadFile(fileData, fileName, fileType?)` — uploads generic files, returns a `file_key`. `fileType` defaults to `"stream"`
- `downloadResource(messageId, fileKey, type)` — downloads Feishu-hosted files/images by message ID and file key. Returns `{ data: Buffer, filename?: string }`. Rejects oversized responses before buffering (`MAX_DOWNLOAD_BYTES` = 50 MB)
- `sendMessage` / `replyMessage` — plain text and card sending

### `ws-client.ts`
Long-lived WebSocket connection to Feishu's event gateway (not user-level WebSocket). Handles:
- Device registration and heartbeat
- Event routing from Feishu to local handlers
- Extracting @mention targets from `mentions` array in message events

The `mentions` array contains objects with `id.open_id`. Compare against `botOpenId` to determine if the bot was mentioned.


### `webhook-server.ts`
Minimal HTTP server on port `3001` (overridable via `FEISHU_WEBHOOK_PORT`). Receives POST callbacks from Feishu when a user clicks a button in a card. Verifies the request signature, parses the action payload, and forwards to `InteractiveHandler`.

## Gotchas

- Token refresh is automatic, but if `FEISHU_APP_ID` or `FEISHU_APP_SECRET` are wrong, the first API call will fail with a 403 and the error surfaces at startup, not lazily.
- The streaming reply card is a normal interactive message updated in place (PATCH /im/v1/messages/{id}), not a CardKit card. Feishu rejects cards with more than 200 components, so `streaming-card.ts` owns a 180-element budget and seals the card into a new one when it overflows.
- The webhook server must be reachable from Feishu's servers. In local dev, use ngrok or equivalent and configure the callback URL in the Feishu app portal.
