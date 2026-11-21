# AGENTS.md

本文件给在本仓库里工作的 agent 使用。人类协作者读 `README.md`。

## 仓库是什么

ComfyUI 的 DSD Director 自定义节点：多镜头导演面板，镜头表写在节点内，参考图 / 参考视频 / 参考音频直接在面板里拖进来，一次生成加可选潜空间超采样，出片同时导出 SRT + EDL。

- `dsd_nodes/` — ComfyUI 节点定义与后端路由（`nodes.py`、`routes.py`），前后端契约的落点
- `dsd/` — **vendored 渲染内核**，是 `film-pipeline/src/dsd/` 的逐字节副本；改动边界与解析顺序（`DSD_SRC` > 包内 `dsd/` > `film-pipeline/src`）见 `VENDOR.md`。要改内核逻辑，改上游再同步过来，不要在这里直接改
- `web/` — 面板前端（原生 JS，`web/js/dsd_director.js`）
- `workflows/` — 可直接导入 ComfyUI 的工作流 JSON
- `docs/` — 设计记录、契约、验证清单（编号递增，只增不改）

## Agent skills

### Issue tracker

议题存放在本仓库的 GitHub Issues（`cxin21/comfyui-dsd-director`），用 `gh` CLI 操作。See `docs/agents/issue-tracker.md`.

### Triage labels

分诊沿用默认五角色（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`），另加 `wayfinder:*` 寻路标签。See `docs/agents/triage-labels.md`.

### Domain docs

single-context — 一个仓库共用一份根目录 `GLOSSARY.md`，架构决定放 `docs/adr/`。See `docs/agents/domain.md`.
