---
category: Changed
---
- A provider content refusal (`CONTENT_REFUSED`, new in dsh 0.2.2-rc.5) does not cool the route when it is not in `triggerCodes`: the provider declined that request, which says nothing about route health. An operator who lists `CONTENT_REFUSED` keeps the existing failover booking.
