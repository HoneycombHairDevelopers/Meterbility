"use client";

import { useState } from "react";

const CMD = "npm install -g @meterbility/cli";

export default function CopyInstall() {
  const [copied, setCopied] = useState(false);

  return (
    <span className="install">
      <span className="d">$</span>
      <span>{CMD}</span>
      <button
        aria-label="Copy install command"
        title="Copy"
        onClick={() => {
          navigator.clipboard.writeText(CMD).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}
