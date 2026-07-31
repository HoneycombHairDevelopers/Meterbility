"use client";

import { useState } from "react";

export default function EnterpriseForm() {
  const [sent, setSent] = useState(false);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = e.currentTarget;
    const v = (name: string) =>
      (f.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)
        .value;
    const subject = encodeURIComponent(
      `Meterbility ${v("tier")} — access request from ${v("company") || v("name")}`
    );
    const body = encodeURIComponent(
      `Name: ${v("name")}\nEmail: ${v("email")}\nCompany: ${v("company")}\nTier: ${v("tier")}\n\nContext:\n${v("notes")}`
    );
    window.location.href = `mailto:enterprise@meterbility.com?subject=${subject}&body=${body}`;
    setSent(true);
  }

  return (
    <form className="form-card" onSubmit={submit}>
      <div className="form-row">
        <div className="field">
          <label htmlFor="f-name">Name</label>
          <input id="f-name" name="name" required placeholder="Ada Lovelace" />
        </div>
        <div className="field">
          <label htmlFor="f-email">Work email</label>
          <input id="f-email" name="email" type="email" required placeholder="ada@company.com" />
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="f-company">Company</label>
          <input id="f-company" name="company" placeholder="Acme Corp" />
        </div>
        <div className="field">
          <label htmlFor="f-tier">Tier</label>
          <select id="f-tier" name="tier" defaultValue="Enterprise">
            <option>Enterprise</option>
            <option>Team</option>
            <option>Not sure yet</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="f-notes">What are you running?</label>
        <textarea
          id="f-notes"
          name="notes"
          placeholder="e.g. 40 engineers on Claude Code, custom agents in production, need SSO + audit logs…"
        />
      </div>
      <button className="btn btn-solid" type="submit" style={{ width: "100%" }}>
        Request access
      </button>
      {sent && (
        <p className="form-ok">
          ✓ Opening your email client — send the drafted message and we&apos;ll get back to you.
        </p>
      )}
      <p className="form-note">
        Submitting drafts an email in your mail client. Or write us directly:{" "}
        <a href="mailto:enterprise@meterbility.com">enterprise@meterbility.com</a>
      </p>
    </form>
  );
}
