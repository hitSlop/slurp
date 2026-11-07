```sql q
SELECT 1 AS a, 2 AS b
```

```chart
query: q
spec:
  mark: bar
  encoding:
    x: {field: nope, type: nominal}
    y: {field: b, type: quantitative}
```
