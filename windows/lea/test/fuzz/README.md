# LEA/USH 模糊测试＋静态分析（S-023）

入口：`windows/lea/test/fuzz/lea_fuzz.c`，驱动：`run_fuzz.sh`，
语料：`corpus/`（15 个）。

## 覆盖表

| 入口 | 覆盖点 |
|---|---|
| `lea_parse_envelope` | v2 信封形状／时间窗／重复键／未知字段／整数严格解析 |
| `lea_envelope_canonical` | 规范串构造（非法字段即失败） |
| `lea_b64_decode` / `lea_b64url_decode` / `lea_b64_encode` | 签名 base64 两路编解码往返 |
| `ush_base64_encode` / `ush_base64_decode` | USH 侧编解码往返（字节一致） |
| `ush_json_get_string/long/llong/bool/double/object` | USH JSON 取值，含 `\u` 转义／代理对路径 |
| `lea_local_status_from_json` / `lea_local_status_to_json` | 本机状态 JSON 编解码往返 |
| `lea_command_spec/tier/is_dangerous/is_cancellable`、`lea_job_deadline_ms` | 命令表派生量 |
| `lea_parse_ticket` | 绑定票据严格解析 |
| `lea_json_is_valid`、`lea_json_top_level_string/long` | 顶层成员严格取值 |

## 语料说明

| 文件 | 含义 |
|---|---|
| `01-valid.json` | 有效 v2 信封（`sys.ping`）；每次跑前由 `run_fuzz.sh` 按当前时间重生成，`issued_at` 须在 now±60s 内才走完整解析 |
| `02-truncated.json` | 有效信封半截截断 |
| `03-bad-base64.txt` | 签名含非法 base64 字符 |
| `04-huge-params.json` | 信封 <65536 但 params >32768，须明确拒绝 |
| `05-nested-timeout.json` | params 内嵌套 `timeout_ms` 遮蔽 |
| `06-n01-long-path.json` | N-01 回归：超长 `file.read` 路径 |
| `07-ush-nested.json` | USH 解析器嵌套对象 |
| `08-ush-unterminated.json` | 未闭合字符串 |
| `09-empty.bin` | 空输入 |
| `10-binary-junk.bin` | 随机二进制垃圾 |
| `11-duplicate-keys.json` | 重复 `command` 键 |
| `12-unknown-field.json` | 未知顶层字段 |
| `13-bad-utf8.json` | 非法 UTF-8 字节 |
| `14-local-status.json` | `lea-status.json` 形输入 |
| `15-unicode-escapes.json` | `\u` 转义：BMP／代理对／孤立低代理／`\uFFFF` |

历史 bug 输入进语料即回归用例：新修解析 bug 时先把触发输入存为
`corpus/NN-<name>.json` 再修，`run_fuzz.sh` 即覆盖。

## 运行

```sh
cd windows/lea/test/fuzz
./run_fuzz.sh   # ASan+UBSan 构建 → 跑 corpus → gcc -fanalyzer 记数
```

fanalyzer 只记数、不卡门（警告数见输出与 `/tmp/fuzz-fanalyzer.log`）。

## 沙箱缺失项（诚实记录，非已覆盖）

- 无 clang → 无 AFL++／libFuzzer：现用独立驱动（`LEA_FUZZ_STANDALONE`）
  逐文件喂语料；有 clang 的环境可不定义该宏、以 libFuzzer 模式链接
  同一 `LLVMFuzzerTestOneInput` 做持续变异 fuzz。
- 无 clang analyzer／CodeQL／MSVC `/analyze`：替代为 `gcc -fanalyzer`。
- Application Verifier、页堆、故障注入：须 11/16 ECS 真机窗口，
  沙箱做不了。
