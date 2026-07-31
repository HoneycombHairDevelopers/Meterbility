export default function Instrument() {
  return (
    <div className="instrument">
      <div className="instrument-bar">
        <span className="tdot" />
        <span className="tdot" />
        <span className="tdot" />
        <span className="instrument-title">meter — zsh</span>
      </div>
      <div className="instrument-body">
        <span className="tc">meter ingest claude-code --limit 5</span>{"\n"}
        <span className="tg">✓</span> <span className="td">ingested 5 sessions · 342 steps · 1.2M tokens</span>{"\n\n"}
        <span className="tc">meter list</span>{"\n"}
        <span className="tb">run_9f3c</span>  <span className="td">claude-code</span>  fix-auth-bug        <span className="ty">$1.84</span>  <span className="td">96 steps</span>{"\n"}
        <span className="tb">run_a210</span>  <span className="td">claude-code</span>  add-billing-page    <span className="ty">$0.62</span>  <span className="td">41 steps</span>{"\n\n"}
        <span className="tc">meter fork run_9f3c --step 44 --continue live</span>{"\n"}
        <span className="tg">✓</span> <span className="td">forked → </span><span className="tv">run_9f3c.fork1</span> <span className="td">(deterministic prefix, live suffix)</span>{"\n\n"}
        <span className="tc">meter diff run_9f3c run_9f3c.fork1</span>{"\n"}
        <span className="td">step 44:</span> <span className="ty">tool_call diverged</span> <span className="td">— Edit(auth.ts) vs Bash(git revert)</span>{"\n\n"}
        <span className="tc">meter web</span>{"\n"}
        <span className="tg">✓</span> <span className="td">inspector live at</span> <span className="tb">http://127.0.0.1:4317</span>
      </div>
    </div>
  );
}
