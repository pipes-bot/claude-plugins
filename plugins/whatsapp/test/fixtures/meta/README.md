# Live BSUID webhook traffic (anonymized)

Captured on 2026-10-08 from a v2 test App on production. The flow was:
1. a user without a username sends "Oi";
2. we reply by BSUID only;
3. we send a `request_contact_info` interactive message;
4. the user shares their phone.

Only the inner `change.value` is from the capture. The `{ object, entry: [{ id, changes }] }` wrapper
is rebuilt. Phone numbers, names, the BSUID, the business number, wamids and the vCard are replaced
with fake values.

What real traffic shows that Meta's dashboard samples don't:
- `sent` and `delivered` statuses carry `recipient_user_id` plus a `contacts` array;
- the `contact_request` reply has a base64 `vcard` (`null` in the samples);
- the `/messages` response for a BSUID recipient is `contacts: [{ input, user_id }]`, with no `wa_id`
  (`send-response-bsuid.json`).
