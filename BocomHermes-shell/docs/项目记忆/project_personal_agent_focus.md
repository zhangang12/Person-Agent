---
name: project_personal_agent_focus
description: "BocomHermes 是个人桌面智能体,功能优先级按个人场景排(防误发/防漏/快速办事),企业合规向的靠后"
metadata: 
  node_type: memory
  type: project
  originSessionId: d1facc36-66bb-490c-9d88-edb74115bf80
---

BocomHermes 定位是**个人桌面智能体**(单人、自己机器、个人/工作邮箱),不是企业/团队产品。给功能排优先级时按个人场景:① 别替我惹祸(防误发)② 别替我漏事(防漏邮件/及时知道)③ 帮我快速办事(找/读/回)。

**Why:** 用户明确纠正过——我一开始用"信贷/合规/多干系人审批链/审计追溯"的企业视角排序,被指出"这是个个人桌面智能体,做关键的功能"。企业味的(reply-all 审批链、合规发件审计、多账号)对个人价值低,应靠后。

**How to apply:** 评估邮件/任何新功能时,先问"对一个人自用值不值",而非"团队/合规要不要"。涉及真发信的(转发/reply-all)风险高,攒成"发信批"等有测试邮箱再做。

2026-06 邮件模块已落地这一批关键功能:防漏(摘要失败退避重试 + 修"先标已跑再拉"时序 bug)、密码明文回退告警、**发件箱延迟发送 + 软撤回(发信安全闸门,默认 15s)**、搜索 + 跨文件夹(mail_search/mail_list_folders)、IMAP IDLE 实时新邮件提醒、HTML 沙箱渲染(网页视图)。相关:[[project_bocomhermes]] [[project_intranet_mode]]
