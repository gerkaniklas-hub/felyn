import type { TextareaHTMLAttributes } from "react";
import { fieldLabelClass, textareaClass } from "./field";

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
};

export function Textarea({ label, id, name, className = "", ...props }: TextareaProps) {
  const textareaId = id ?? name;

  return (
    <label htmlFor={textareaId} className="flex flex-col gap-1.5">
      <span className={fieldLabelClass}>{label}</span>
      <textarea id={textareaId} name={name} className={`${textareaClass} ${className}`} {...props} />
    </label>
  );
}
