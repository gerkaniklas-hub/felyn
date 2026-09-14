import type { TextareaHTMLAttributes } from "react";

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
};

export function Textarea({ label, id, name, className = "", ...props }: TextareaProps) {
  const textareaId = id ?? name;

  return (
    <label htmlFor={textareaId} className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-navy-700">{label}</span>
      <textarea
        id={textareaId}
        name={name}
        className={`min-h-28 rounded-xl border border-ivory-400 bg-ivory-50 px-4 py-3 text-base text-navy-900 outline-none transition-colors placeholder:text-navy-300 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 ${className}`}
        {...props}
      />
    </label>
  );
}
