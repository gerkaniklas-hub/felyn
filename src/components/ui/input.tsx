import type { InputHTMLAttributes } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
};

export function Input({ label, id, name, className = "", ...props }: InputProps) {
  const inputId = id ?? name;

  return (
    <label htmlFor={inputId} className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-navy-700">{label}</span>
      <input
        id={inputId}
        name={name}
        className={`h-11 rounded-xl border border-ivory-400 bg-ivory-50 px-4 text-base text-navy-900 outline-none transition-colors placeholder:text-navy-300 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 ${className}`}
        {...props}
      />
    </label>
  );
}
