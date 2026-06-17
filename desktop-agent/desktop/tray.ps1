# 极简系统托盘：从本地 REST 拉能力列表，点菜单项即运行并弹出结果。
# 用法：powershell -ExecutionPolicy Bypass -File desktop\tray.ps1
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$rest = "http://127.0.0.1:5174"

try { $caps = Invoke-RestMethod -Uri "$rest/capabilities" -Method Get }
catch { [System.Windows.Forms.MessageBox]::Show("连不上宿主 $rest，请先启动 npm start", "桌面智能体"); exit }

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.SystemIcons]::Application
$ni.Visible = $true
$ni.Text = "桌面研发智能体"

$menu = New-Object System.Windows.Forms.ContextMenuStrip
foreach ($c in $caps) {
    $item = $menu.Items.Add("$($c.name)  [$($c.id)]")
    $id = $c.id
    $item.Add_Click({
        try {
            $r = Invoke-RestMethod -Uri "$rest/run/$id" -Method Post -ContentType "application/json" -Body '{}'
            $text = if ($r.text) { $r.text } else { ($r | ConvertTo-Json -Depth 6) }
            $len = [Math]::Min(1800, $text.Length)
            [System.Windows.Forms.MessageBox]::Show($text.Substring(0, $len), "结果: $id")
        } catch {
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "错误: $id")
        }
    }.GetNewClosure())
}
$null = $menu.Items.Add("-")
$exit = $menu.Items.Add("退出")
$exit.Add_Click({ $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$ni.ContextMenuStrip = $menu

[System.Windows.Forms.Application]::Run()
