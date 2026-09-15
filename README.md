# 台灣電力觀察站｜GitHub Pages 版

這是一個純 HTML 網站。GitHub Actions 會在每小時第 17 分鐘，自動抓取台電公開資料並保存，不需要讓瀏覽器一直開著，也不需要申請台電 API 金鑰。

## 第一次放到 GitHub

1. 登入 GitHub，右上角按「＋」→「New repository」。
2. Repository name 建議填 `taiwan-power-observatory`。
3. 建議選擇 Public。網站使用的都是公開資料；Public 儲存庫也最容易使用 GitHub Pages。
4. 建立後按「uploading an existing file」，把本資料夾裡的所有內容拖進去。請確認 `.github/workflows/collect-power.yml` 也有上傳。
5. 按「Commit changes」。

## 啟用 GitHub Pages

1. 進入儲存庫的「Settings」。
2. 左側選「Pages」。
3. 在「Build and deployment」的 Source 選「GitHub Actions」。

## 執行第一次資料更新與發布

1. 回到儲存庫的「Actions」。
2. 若首次使用時看到啟用 Actions 的按鈕，先按下啟用。
3. 左側選「每小時更新台電資料」。
4. 按「Run workflow」→「Run workflow」。
5. 等候綠色勾勾出現；該次流程會同時抓資料、保存歷史紀錄並發布網站。
6. 回到「Settings」→「Pages」，即可看到網站網址：
   `https://你的帳號.github.io/taiwan-power-observatory/`

這個流程只使用 GitHub 自動提供、工作結束後就會失效的儲存庫權限，而且權限僅限這個儲存庫；不需要自行建立或填入任何 API 金鑰。

## 自動更新方式

- GitHub Actions：每小時第 17 分鐘抓一次台電資料。
- 抓取完成後，同一次流程會直接更新 GitHub Pages，不依賴第二個推送事件。
- `data/latest.json`：最新一筆資料。
- `data/recent.json`：最近 35 天，供 24 小時、7 日與 30 日圖表使用。
- `data/archive/YYYY-MM.json`：按月份保存的長期資料。
- 若某次排程失敗，網站會保留最後成功資料，不會用推算值補洞。
- GitHub 排程並非準時制，高流量時可能延後數分鐘；選在第 17 分是為了避開整點尖峰。
- 公開儲存庫若連續 60 天沒有任何活動，GitHub 可能自動停用排程；到 Actions 頁重新啟用即可。

## 常見問題

### Actions 顯示沒有權限推送或發布

先確認「Settings」→「Pages」的 Source 已選「GitHub Actions」。若仍顯示推送權限錯誤，再到「Settings」→「Actions」→「General」→「Workflow permissions」選擇「Read and write permissions」。

### 網站沒有更新

先到「Actions」查看「每小時更新台電資料」最近一次是否成功。GitHub 排程可能有數分鐘延遲，不保證剛好在第 17 分執行；公開儲存庫超過 60 天沒有活動時，也要確認排程是否被停用。

### 想立即抓一次資料

到「Actions」→「每小時更新台電資料」→「Run workflow」。完成後 GitHub Pages 會重新發布資料。
