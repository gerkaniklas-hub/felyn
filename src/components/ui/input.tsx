import type { InputHTMLAttributes } from "react";
import { fieldClass, fieldLabelClass } from "./field";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
};

export function Input({ label, id, name, className = "", ...props }: InputProps) {
  const inputId = id ?? name;

  return (
    <label htmlFor={inputId} className="flex flex-col gap-1.5">
      <span className={fieldLabelClass}>{label}</span>
      <input id={inputId} name={name} className={`${fieldClass} ${className}`} {...props} />
    </label>
  );
}
