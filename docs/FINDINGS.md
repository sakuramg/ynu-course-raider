# 技术发现详细版（含实验数据）

本文档记录 YNU 选课系统逆向过程中通过对照实验获得的全部技术发现。所有数据来自真实环境实测。

## 1. 接口协议

| 接口 | 方法 | 用途 | 需要 CSRF |
|---|---|---|---|
| `/xsxkHome/loadPublicInfo_course.do` | GET | 获取页面公共信息（含 csrfToken） | 否 |
| `/sys/xsxkapp/xsxkCourse/loadJhnCourseInfo.do` | POST | 查询可选课程（含容量/冲突） | 否 |
| `/sys/xsxkapp/xsxkCourse/loadStdCourseInfo.do` | GET | 查询已选课程 | 否 |
| `/sys/xsxkapp/xsxkCourse/choiceCourse.do` | POST | **提交选课** | **是** |
| `/sys/xsxkapp/xsxkCourse/loadXkjgRes.do` | POST | 轮询选课结果（xid） | 否 |
| `/sys/xsxkapp/login/4/vcode.do` | GET | 获取验证码 token | - |
| `/sys/xsxkapp/login/vcode/image.do` | GET | 获取验证码图片 | - |

提交请求体：`{bjdm, lx, csrfToken, secretKey?}`（`secretKey` 从 URL 查询参数条件附加，官方 `getRequest()` 逻辑）。

## 2. CSRF token 机制（关键）

- 来源：`loadPublicInfo_course.do` 响应中的 `csrfToken`，由服务端按会话生成，注入页面 `#csrfToken` 隐藏域。
- **TTL 实测**：
  - 2026-08-27：页面年龄 109s → 提交进入业务层（"时间冲突"）；277s → 返回"页面已过期"。
  - 2026-08-29：页面年龄 107s → 已返回"页面已过期"。
  - **结论：TTL 波动大（100~230s），保鲜阈值须保守（75s）。**
- **查询接口不需要 token**，所以"轮询一切正常"和"提交必死"可以同时成立——**读路径全绿 ≠ 写路径可用**。
- **无效 bjdm 是防探测骗局**：用无效课程代码提交，后端不校验 token 直接返回"容量已满"（防爬虫探测）。探针必须用真实课程（如与自己课表冲突的课，提交无副作用），或干脆纯时间保鲜。

## 3. 验证码 OCR 实测

| 方案 | 识别率 | 备注 |
|---|---|---|
| 本地 qwen2.5vl:3b | <30% | 不可用 |
| 本地 qwen3-vl:4b | 17~33% | 不可用 |
| 本地 minicpm-v | 17% | 不可用 |
| 本地 qwen3-vl:8b | 无提升 | 且 ~60s/次 |
| tesseract / 模板匹配 | 不可靠 | 70x30 小图 |
| **云端 qwen3.8-max** | **5/6 (83%)** | **唯一可行** |
| 云端 qwen3.8-27b | 稳定、延迟 2-3s | 候选与 max 互补 |
| 云端 qwen3.5-omni-plus | 稳定 | 候选互补 |
| 云端 qwen-vl-ocr / qwen3.5-ocr | **丢字符** | OCR 专用模型对小图反而不行 |

要点：
- 验证码**无小写字母**（学校系统），识别约束为大写+数字。
- **云端原图不放大、本地 x8 放大**（OCR 模型实测放大后丢字符）。
- 三模型候选合并（temp 0/0.3/0.6 采样）后去重投票，取 top1 提交；4 张图 × top1 = 4 个独立样本。

## 4. Ego Browser 稳定性

- **渲染进程卡死**：长时间运行后 `Runtime.evaluate` 全超时（连 readyState 都不响应），系统内存正常。`gotoAndWait` 刷新是诱因；关闭页签重开是解药（4ms 恢复）。预防性每 ~4h 重建一次。
- **gotoAndWait 超时是假失败**：30s 超时但页面实际加载成功——用 60s 超时 + 页面就绪四项轮询（URL/BaseUrl/jQuery/DES）。
- **系统代理崩溃 = 网络全挂**：页面 HTML 能加载但内联 JS 的 fetch/XHR 全失败（`Failed to fetch`），表现为"页面半死"。查 `nc -z 127.0.0.1 7890`。

## 5. 登录频率限制

- 验证码错误 5 次内安全；锁定码形如 `#E2140600091`。
- **网络错误（HTTP 失败）code=0 不是锁定**——只对明确锁定码或锁定文案才长暂停，否则网络抖动会误暂停 1 小时。
- 登录日志只记录分类（LOCK_HINT/EXPIRED/OTHER）不记录原始消息（防个人标识泄露）。

## 6. 工程实践

- **写路径必须实测**：读路径（查询）全绿不代表写路径（提交）可用——token 独立过期是血泪教训。
- **async 改造全链路审计**：漏一个 await，`"[object Promise]"` 会被当真实验证码提交并触发账号锁定。离线回归测试（stub + 断言）必须跟上。
