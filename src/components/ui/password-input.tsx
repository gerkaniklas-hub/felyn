"use client";

import { useState, type InputHTMLAttributes } from "react";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: string;
};

/** A labeled password field with a Show/Hide toggle, per the Felyn login spec. */
export function PasswordInput({
  label,
  id,
  name,
  className = "",
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const inputId = id ?? name;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-navy-700">{label}</span>
      <div className="flex items-center gap-2 rounded-xl border border-ivory-400 bg-ivory-50 pr-3 focus-within:border-sky-500 focus-within:ring-2 focus-within:ring-sky-100">
        <input
          id={inputId}
          name={name}
          type={visible ? "text" : "password"}
          className={`h-11 flex-1 rounded-xl bg-transparent px-4 text-base text-navy-900 outline-none placeholder:text-navy-300 ${className}`}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="shrink-0 text-xs font-medium text-sky-600 hover:text-sky-700"
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}
