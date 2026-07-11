# Sheet Sync Manager — Update Sequence

How the card printer keeps the designer, the PDF preview, and the shared Google Sheet in sync.
Source: `index.html` — `sync` object, `pollSheetOnce`, `materializeSheetConfigs`.

---

## 1. The big picture — two independent channels

```mermaid
flowchart LR
    subgraph Browser["Browser (card printer)"]
        ED[Card designer /<br>content editor]
        CFG["In-memory state<br>cardConfig / templateConfig<br>+ dirty flags"]
        LS[(localStorage<br>dirty overlay)]
        Q["sync queue<br>Map: A1 → value<br>(newest wins)"]
    end
    SHEET[(Google Sheet<br>content + metaData + t0)]

    ED -->|every edit| CFG
    CFG -->|persist dirty| LS
    CFG -->|"signed in only"| Q
    Q -->|"flush ≤1.5s<br>values:batchUpdate"| SHEET
    SHEET -->|"READ: 15s gviz poll<br>(pausable)"| CFG
```

* **Writes** (right): only when signed in, debounced 1.5 s, batched into 1–2 HTTP calls.
* **Reads** (bottom): the 15 s poll — one CSV containing content **and** layout configs.
* **Pause freezes BOTH channels**: reads stop, and queued writes wait (badge/pill: `⏸ N changes waiting`). Resume drains in sync order: ① flush writes → ② read → ③ restart the 15 s cadence. Tab close while paused still fires the keepalive rescue write.

---

## 2. Write path — what happens when you edit (signed in)

```mermaid
sequenceDiagram
    participant U as User
    participant E as Editor (afterEdit)
    participant Q as sync queue
    participant G as Google Sheets API
    participant M as In-memory sheet state<br>(sheetCardMeta / sheetTemplate)

    U->>E: drag / type / change font
    E->>E: mark card dirty + save to localStorage
    E->>Q: enqueue(A1, json)

    Note over Q: ⑤ No-op skip:<br>value == confirmed[A1]?<br>→ skip (and cancel queued write)

    Note over Q: coalesce per cell —<br>50 drags of one card = 1 write<br>badge: "Saving in 2s… (N pending)"

    Q->>G: after 1.5s — ONE values:batchUpdate<br>(RAW batch + USER_ENTERED batch)

    alt success
        G-->>Q: 200 OK
        Q->>Q: confirmed[A1] = value
        Q->>M: ① local echo — written value<br>becomes the sheet state
        M->>E: settleDirty → card clean (~2s, no poll wait)
        Q->>Q: ④ flash "✓ Saved N cell(s)"
        Q->>Q: ③ re-anchor 15s read poll
    else failure
        G-->>Q: error
        Q->>Q: re-queue (newer values win)<br>retry in 5s
    end
```

---

## 3. Read path — the 15 s poll

```mermaid
sequenceDiagram
    participant T as 15s timer<br>(pause button countdown)
    participant S as Google Sheet (gviz CSV)
    participant R as reconcileCardConfigs

    T->>S: fetch whole sheet CSV
    S-->>T: content + metaData + t0
    alt text unchanged
        T->>T: nothing to do ("Live • synced")
    else changed
        T->>T: clear confirmed cache (⑤ safety)
        T->>R: re-parse rows + configs
        Note over R: CLEAN cards → follow the sheet<br>DIRTY cards → keep local layout<br>template → adopt unless mid-edit
    end
```

**Pause** freezes the whole sync manager — this read channel (content *and* configs) **and** the write queue. On resume: writes flush first, then this poll runs, then the 15 s timer restarts.

```mermaid
sequenceDiagram
    participant U as User
    participant P as Pause state
    participant Q as Write queue
    participant S as Sheet

    U->>P: ⏸ Pause (button or pill click)
    Note over Q: edits keep queuing —<br>"⏸ N changes waiting"
    U->>P: ▶ Resume
    P->>Q: ① flush queued writes
    Q->>S: batchUpdate
    P->>S: ② read (poll) — sees our writes
    P->>P: ③ restart 15s cadence
```

---

## 4. Lifecycle — anonymous vs signed in

```mermaid
flowchart TD
    A[Page load] --> B{Sheet has config?}
    B -->|yes| C["Use sheet config<br>(completed over code defaults —<br>missing fields e.g. priceHalf filled)"]
    B -->|no| D[localStorage tweak → template → src default]

    C --> E{Edit something}
    D --> E
    E -->|anonymous| F["Local only: in-memory + localStorage<br>survives 15s polls (dirty guard)<br>LOST on page reload"]
    E -->|signed in| G["sync queue → sheet<br>shared with every device"]

    H[Sign in] --> I["materializeSheetConfigs (once):<br>• empty cells → filled<br>• incomplete configs → completed & rewritten<br>• t0 wrong type marker → corrected"]
    I --> G
```

---

## 5. Close-tab safety net

```mermaid
flowchart LR
    X[Tab closing] --> Y{queue empty?}
    Y -->|yes| Z[close silently]
    Y -->|no| W["② keepalive batch write<br>(survives page close)"]
    W --> V["+ leave-warning dialog<br>(keepalive is best-effort)"]
```

---

## Status surfaces (consolidated)

| Surface | Owns | Example |
|---|---|---|
| **Sync pill** (fixed top-right) | the ONE at-a-glance data in/out state | `🟢 Live — updated just now` · `💾 Saving 3 changes (2s)…` · `✓ All changes saved` · `⏸ Paused — not pulling updates` · `✏️ Local preview — sign in to save` · `⚠ Save failed — retrying` |
| **Designer badge** (on the card) | save countdown + font/auto-flow chips | `💾 Saving 3 changes (2s)…` → `✓ All changes saved` |
| **Pause button** | read-poll control | `Pause auto-refresh (12s)` + draining fill / amber `⏸ Paused` |
| **Section 1 statuses** | setup only | connect errors, `Editable • Tab • 147 rows` |

Pill priority (top wins): write error → read error → saving → just-saved → paused → anonymous-with-local-edits → live.

## Timing cheat sheet

| Thing | Cadence | Visual |
|---|---|---|
| Write flush | 1.5 s after first queued edit | pill + badge: `💾 Saving N changes (2s)…` |
| Write retry on failure | 5 s | pill: `⚠ Save failed — retrying` |
| Save confirmation | ~2 s (local echo) | pill + badge flash: `✓ All changes saved` |
| Read poll | 15 s, pausable | pause button countdown + pill `updated Ns ago · ↻ 12s` |
| Paused | reads AND writes frozen (queue waits) | amber pill `⏸ Paused — N changes waiting` + amber button |
| Resume | write → read → restart cadence | pill walks `💾 Saving… → ✓ → 🟢 Live` |

**Numbered optimizations** in the diagrams: ① local echo ② keepalive close-flush ③ poll re-anchor after own write ④ countdown + ✓ flash ⑤ no-op write skip.
