# Markdown constructs

Intro with **bold**, *italic*, `code`, a [link](https://example.com), a bare https://example.com/auto and ~~strike~~.

## Lists

- one
  - nested a
  - nested b
    1. deep ordered
- [x] done task
- [ ] open task

1. first
2. second

| Plan | Users | Share |
|---|--:|:-:|
| Free | 1,204 | 80% |
| Pro | 301 | 20% |

> A blockquote with **bold** text.
>
> Second paragraph.

```python
def very_long_line():
    return "this code line is intentionally extremely long so that it overflows the page width in the rendered report output 0123456789 0123456789 0123456789 0123456789"
```

---

Inline <b>html</b> and <img src="https://example.com/x.png"> and <iframe src="https://evil.example"></iframe>

<details><summary>Raw html details</summary>hidden</details>

Footnote ref[^1].

[^1]: The footnote text.

~~~sql tilde
SELECT 9 AS n
~~~

```metric
query: tilde
field: n
label: From tilde fence
```

Final paragraph with a very long unbroken token: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
