# Vendored Ed25519（仅验签路径）

## 来源
- 上游：Orlp `ed25519`（https://github.com/orlp/ed25519，master，2026-11-11 取回）。
- 许可：见 `LICENSE.txt`（Orson Peters，zlib 风格宽松许可：可商用、可改写、
  可再分发；不得谎称原创、改动须标明、不得删除声明）。本目录文件为上游
  原文，未改动一行（仅取验签所需子集）。
- 取回方式：`curl codeload.github.com/orlp/ed25519/tar.gz/refs/heads/master`。

## 取了什么（仅验签，不含签名／密钥生成）
- `verify.c`、`ge.c`、`fe.c`、`sc.c`、`sha512.c`
- `ed25519.h`、`ge.h`、`fe.h`、`sc.h`、`sha512.h`、`fixedint.h`、`precomp_data.h`
- 未取：`sign.c`、`keypair.c`、`seed.c`、`key_exchange.c`、`add_scalar.c`
  （LEA 永不签名、不生成密钥，不需要；不引入可减小攻击面）。
- `ed25519.h` 声明了全部 API（含未引入的签名函数），仅声明无定义；
  LEA 只调用 `ed25519_verify()`，链接不依赖其余函数。

## 为什么用它（不用自写、不用系统库）
- Windows CNG（bcrypt）在 mingw 头文件里无 Ed25519 定义，且 LEA 目标
  `_WIN32_WINNT 0x0600`，CNG Ed25519（Win10 1709+）不兼容。
- mingw 无 OpenSSL／libsodium 可用；仓库内无现成 Ed25519 实现。
- 自写 Ed25519（SHA-512＋曲线运算）工作量大、易错；Orlp 实现是广泛使用
  的公有领域级小实现，验签逻辑已用独立实现交叉验证（见下）。

## 正确性验证（2026-11-11）
- Python `cryptography`（OpenSSL）生成测试密钥对并签名规范串；
  本实现验签通过；Node `crypto`（第三个独立实现）同样验签通过。
  三方一致：`evidence-ed25519-20261111/test_vectors.txt`、
  `/tmp/validate_ed25519.c`（7 项全过，见 REPORT.md）。
- 单元测试：`windows/lea/test/test_lea.c` 签名段（带测试公钥构建时）。

## 公钥来源
- 验签公钥由编译期宏 `LEA_SERVER_PUBKEY_HEX`（64 字符 hex，32 字节）
  注入，见 `../lea_crypto.c` 的 `lea_server_pubkey_hex()`。
  未定义该宏时返回 NULL，验签 fail-closed（与占位行为一致）。
- 生产部署流程：另行生成稳定的服务端 Ed25519 密钥对 → 服务端配
  `signingKeyFile` → 取公钥 hex 以该宏编入 LEA 构建 → 重编＋重测。
  测试构建用测试公钥（见 `../test/run_tests.sh` 的 `LEA_TEST_PUBKEY_HEX`）。
