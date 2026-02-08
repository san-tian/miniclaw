# Mini-Claw 快速演示场景


## 场景 1: 晨间咖啡简报 (1分钟)

**展示能力**: `cron` 定时任务 + web search + telegram 主动发送消息

```
每天早上 8 点，帮我搜索 AI 领域的最新突破性进展，整理成 3 条简报，用轻松的语气发到我的 telegram

telegram：进行提问
```

## 场景 2: 一次性脚本工坊 (1分钟)

**展示能力**: `write` + `read` + `bash`

```
从web：
帮我写一个 Python 脚本，扫描~/code目录下所有 .md 文件，不包含子文件夹，输出他们的行数。之后read工具分析每一个文件的内容，输出一份简洁的报告。跑完之后把脚本删掉。

从telegram：
读取~/code下面的关于telegram bot架构的markdown，给我总结一下内容。
```
telegram执行不了特别复杂的脚本。

## 场景 3: 竞品情报并行调研 (1分钟)

**展示能力**: `subagent_spawn` 并行处理

```
后台同时帮我调研这四家公司的最新动态：OpenAI、Google DeepMind、Anthropic、Macaron AI。每家给我一段 100 字以内的摘要，最后汇总成一份对比表格发给我。
```
ok

## 场景 4: Telegram 随手问，深度答 (2分钟)

**展示能力**: 多工具组合 + telegram 请求

```
用户从 telegram: 最近很火的 "Vibe Coding" 到底是什么？帮我查一下，写一段通俗易懂的解释，再给我列 3 个实际的应用例子
```

ok


## 场景 5: 代码仓库守夜人 (7x24小时监控)

**展示能力**: `cron` + `bash`(git) + `read` + `write` + telegram 通知

```
帮我监控这个代码仓库：https://github.com/san-tian/Test.git，每当有新的提交，你就 pull 下来，读取变更的文件，把文件里的每一行注释按照原来的缩进改成一句名人名言，然后 push 回去。完成后给我的 telegram 发一条通知，告诉我改了哪些文件、用了哪些名言。
```
