# Overview

```sql daily
SELECT date_trunc('day', timestamp) AS day, count(*) AS events FROM events GROUP BY 1 ORDER BY 1
```

```table
query: daily
```

```sql top_events
SELECT event, count(*) AS events FROM events GROUP BY event ORDER BY events DESC LIMIT 20
```

```table
query: top_events
```
