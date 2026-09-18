# `msg` 自由文本

写给人看的一行注解。

```ebnf
msg = "msg" , <文本>
```

- `<文本>` = `msg` 之后直到行尾的全部内容（去首尾空白）。**不解析**逗号、属性与注释。
- 若整段恰好是一个合法字符串字面量（`"..."`），解析器会剥掉引号并解码转义。

**什么时候用**：仿真开始/结束、模式切换、已知异常的说明；工具产生的"文件说明"行。

```chiperf
[msg] reset released, starting trace
[msg] "entering turbo mode"
[msg] simulated 1e6 cycles; see note #3 in the README     # 整个 "simulated … README" 都是正文
```

⚠️ `msg` **不支持任何属性**：`dom=`、`at=`、`async=`、`note=` 都会被当成正文的一部分。
需要带定位/标记的注解就用 `evt` + `note=`。
⚠️ 因为"取正文"发生在剥注释**之前**，`[msg] a # b` 的正文是 `a # b`（那个 `#` 不是注释）。
