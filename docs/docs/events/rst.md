# `rst` 系统复位（控制记录）

丢弃这行**之前**的全部事件记录，从这一行重新开始。  

## 语法

```chiperf
[rst]
```

EBNF 表达式: 
```ebnf
rst = "rst" ;
```


## 参数

`rst` **不允许**任何参数或属性（`at=`/`async=` 都不行）。


## 解释

`rst` 事件允许在不修改 RTL testbench 并添加 `initial` 的情况下实现初始化。  
这意味着可以直接在 **实际设计的模块内部** 进行记录，与 testbench 等仿真脚手架解耦合。

## 示例

```chiperf
chiperf 1.0
[clk] p
[cnt] "cold.reset.warmup"          # 这一段之后会被丢掉
[clk] n
[rst]                              # 从这行起，前面的记录当作没发生过
[clk] p
[cnt] "core.retired"               # 复位后重新开始累计
@end
```
