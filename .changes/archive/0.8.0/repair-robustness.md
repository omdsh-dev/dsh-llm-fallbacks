---
category: Fixed
---
- A parameter-repair retry no longer replays the rejected request's `usage` chunk: the repaired logical attempt emits exactly one `usage`, belonging to the attempt that actually ran.
- A throwing debug logger can no longer cancel a proactive parameter drop; the request still goes out with the unsupported control removed.
