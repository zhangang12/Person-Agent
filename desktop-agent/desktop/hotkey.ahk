; 全局热键 → 调本地 REST（需要 AutoHotkey v2）
; 用法：双击运行本脚本；在任意窗口按热键即可触发能力。
#Requires AutoHotkey v2.0

REST := "http://127.0.0.1:5174"

; Ctrl+Alt+R = 代码评审当前 git diff
^!r:: RunCap("review", "")

; Ctrl+Alt+L = 需求定位（取剪贴板内容作为需求文本）
^!l:: RunCap("locate", A_Clipboard)

RunCap(id, input) {
    global REST
    ; 转义双引号与反斜杠，拼最简 JSON
    s := StrReplace(input, "\", "\\")
    s := StrReplace(s, '"', '\"')
    s := StrReplace(s, "`n", "\n")
    body := '{"input":"' s '"}'
    try {
        http := ComObject("MSXML2.XMLHTTP")
        http.open("POST", REST "/run/" id, false)
        http.setRequestHeader("Content-Type", "application/json")
        http.send(body)
        TrayTip("桌面智能体", "已完成：" id, 1)
    } catch as e {
        TrayTip("桌面智能体", "调用失败：" e.Message, 3)
    }
}
