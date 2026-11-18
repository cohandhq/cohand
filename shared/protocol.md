# Pi Browser Wire Protocol v1

JSON frames over WebSocket (extension → pi connects out to ws://127.0.0.1:<port>).

## Frames

- hello (ext→pi):      {"v":1,"type":"hello","token":"<hex>","profile":"<label>"}
- welcome (pi→ext):    {"v":1,"type":"welcome","ok":true}  — anything else: close
- cmd (pi→ext):        {"v":1,"id":<n>,"type":"cmd","cmd":"<name>","args":{...}}
- result (ext→pi):     {"v":1,"id":<n>,"type":"result","ok":true,"data":{...}}
                       {"v":1,"id":<n>,"type":"result","ok":false,"error":"<msg>"}
- event (ext→pi):      {"v":1,"type":"event","event":"log"|"tab_activated","data":{...}}

Rules: unknown cmd → result ok:false "unknown_cmd". Max frame 1 MiB. ids monotonic per
pi session. Commands time out after 30s on the pi side.

Daemon client operations include `session.start {name}` (new identity), `session.resume {id}`
(existing identity), `session.end`, `session.list`, and `adopt {tabId, anyTab?}`. `adopt` is
an explicit move of one existing tab; the extension preserves its tab ID and page state and
uses the current session group. Outside-group adoption is permitted only when the profile's
existing any-tab policy allows it.
