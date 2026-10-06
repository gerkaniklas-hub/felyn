"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  detectInternationalPhone,
  getPhoneCountries,
  getPhoneCountry,
  getPhonePlaceholder,
  searchPhoneCountries,
} from "@/lib/phone";

type FlagSet = Record<string, ComponentType<{ className?: string }>>;

let flagSetPromise: Promise<FlagSet> | null = null;

/**
 * All ~250 SVG flags are one sizeable module, so it is loaded on demand in
 * its own chunk (once per page) instead of being part of every form's
 * bundle. Until it arrives a neutral placeholder takes the flag's place.
 * SVG rather than emoji flags: Windows doesn't draw flag emoji at all.
 */
function loadFlags(): Promise<FlagSet> {
  flagSetPromise ??= import("country-flag-icons/react/3x2").then((module) => module as unknown as FlagSet);
  return flagSetPromise;
}

function CountryFlag({ code, flags }: { code?: string; flags: FlagSet | null }) {
  const Flag = code && flags ? flags[code] : undefined;
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-4 w-6 shrink-0 overflow-hidden rounded-[3px] bg-ivory-300 ring-1 ring-navy-950/10"
    >
      {Flag ? <Flag className="h-full w-full" /> : null}
    </span>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true" className={className}>
      <path d="M5 7.5l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export type PhoneInputValue = { country: string; number: string };

type PhoneInputProps = {
  label?: string;
  /** Base for the element ids; one is generated if omitted. */
  id?: string;
  /** Form field names: the ISO country code and the number as typed. */
  countryName?: string;
  numberName?: string;
  defaultCountry?: string;
  defaultNumber?: string;
  error?: string;
  /** Which part the error is about (highlighted in red; the number is also marked aria-invalid). Both if omitted. */
  errorField?: "country" | "number";
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  onChange?: (value: PhoneInputValue) => void;
};

/**
 * [ country ] [ national number ]. The country is always chosen
 * explicitly — there is no default and nothing is inferred from the
 * browser. The form receives the ISO code and the number as typed; the
 * E.164 form is produced by validatePhone() (src/lib/phone.ts), on the
 * server before anything is saved.
 *
 * Country picker: a button that opens a searchable listbox (name, ISO
 * code, "+49" or "49"). The search field is an ARIA combobox: ↑/↓ move,
 * Enter selects, Esc closes, Tab leaves. A popover from sm up, a sheet on
 * phones. A pasted "+…" number switches to its country automatically.
 *
 * Uncontrolled from the parent's point of view: remount it (key) to reset
 * it to new defaults.
 */
export function PhoneInput({
  label = "Mobile number",
  id,
  countryName = "phoneCountry",
  numberName = "phoneNumber",
  defaultCountry = "",
  defaultNumber = "",
  error,
  errorField,
  hint,
  disabled = false,
  required = false,
  onChange,
}: PhoneInputProps) {
  const generatedId = useId();
  const baseId = id ?? `phone${generatedId.replace(/:/g, "")}`;
  const ids = {
    label: `${baseId}-label`,
    button: `${baseId}-country`,
    number: `${baseId}-number`,
    search: `${baseId}-search`,
    list: `${baseId}-list`,
    message: `${baseId}-message`,
  };
  const optionId = (code: string) => `${baseId}-option-${code}`;

  const [country, setCountry] = useState(defaultCountry);
  const [number, setNumber] = useState(defaultNumber);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [flags, setFlags] = useState<FlagSet | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const numberRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const countries = useMemo(() => getPhoneCountries(), []);
  const results = useMemo(() => searchPhoneCountries(countries, query), [countries, query]);
  const selected = country ? getPhoneCountry(country) : undefined;
  const active = results[activeIndex];

  useEffect(() => {
    let cancelled = false;
    loadFlags()
      .then((set) => {
        if (!cancelled) setFlags(set);
      })
      .catch(() => {
        // No flags is cosmetic only: names and codes still show.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (open && active) document.getElementById(optionId(active.code))?.scrollIntoView({ block: "nearest" });
    // optionId only depends on baseId, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  function update(next: PhoneInputValue) {
    setCountry(next.country);
    setNumber(next.number);
    onChange?.(next);
  }

  function openList() {
    if (disabled) return;
    setQuery("");
    setActiveIndex(Math.max(0, countries.findIndex((entry) => entry.code === country)));
    setOpen(true);
  }

  function closeList(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  function choose(code: string) {
    update({ country: code, number });
    setOpen(false);
    numberRef.current?.focus();
  }

  /** "+49 151…" pasted or typed: switch to that country and keep the national part. */
  function adoptInternational(value: string): boolean {
    const detected = detectInternationalPhone(value);
    if (!detected) return false;
    update({ country: detected.country, number: detected.national });
    return true;
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const last = results.length - 1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, last));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
        break;
      case "PageDown":
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 8, last));
        break;
      case "PageUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 8, 0));
        break;
      case "Enter":
        // Never submits the surrounding form.
        event.preventDefault();
        if (active) choose(active.code);
        break;
      case "Escape":
        event.preventDefault();
        closeList(true);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  function handleButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openList();
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    if (adoptInternational(event.clipboardData.getData("text"))) event.preventDefault();
  }

  const message = error ?? hint;
  const countryInvalid = Boolean(error) && errorField !== "number";
  const numberInvalid = Boolean(error) && errorField !== "country";
  const describedBy = message ? ids.message : undefined;
  const fieldClass =
    "h-11 rounded-full border bg-ivory-50 text-base text-navy-900 outline-none transition-colors focus:border-sky-500 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div ref={containerRef} role="group" aria-labelledby={ids.label} className="flex flex-col gap-1.5">
      <label id={ids.label} htmlFor={ids.number} className="text-sm font-medium text-navy-700">
        {label}
      </label>

      <div className="@container relative">
        <div className="flex flex-col gap-2 @md:flex-row">
          <button
            ref={buttonRef}
            id={ids.button}
            type="button"
            disabled={disabled}
            onClick={() => (open ? closeList(false) : openList())}
            onKeyDown={handleButtonKeyDown}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? ids.list : undefined}
            aria-label={selected ? `Country: ${selected.name}, +${selected.callingCode}. Change country` : "Choose your country"}
            aria-describedby={describedBy}
            className={`${fieldClass} flex w-full shrink-0 items-center gap-2.5 px-4 text-left @md:w-60 ${
              countryInvalid ? "border-red-400" : "border-ivory-400"
            }`}
          >
            <CountryFlag code={selected?.code} flags={flags} />
            {selected ? (
              <>
                <span className="min-w-0 flex-1 truncate" suppressHydrationWarning>
                  {selected.name}
                </span>
                <span className="text-navy-500">+{selected.callingCode}</span>
              </>
            ) : (
              <span className="flex-1 text-navy-300">Choose country</span>
            )}
            <ChevronDown className={`h-4 w-4 shrink-0 text-navy-300 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>

          <input
            ref={numberRef}
            id={ids.number}
            name={numberName}
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            value={number}
            onChange={(event) => update({ country, number: event.target.value })}
            onPaste={handlePaste}
            onBlur={() => {
              if (number.trim().startsWith("+")) adoptInternational(number);
            }}
            placeholder={getPhonePlaceholder(country) ?? "Phone number"}
            disabled={disabled}
            required={required}
            maxLength={40}
            aria-invalid={numberInvalid || undefined}
            aria-describedby={describedBy}
            className={`${fieldClass} w-full min-w-0 px-4 placeholder:text-navy-300 @md:flex-1 ${
              numberInvalid ? "border-red-400" : "border-ivory-400"
            }`}
          />
        </div>

        {open ? (
          <>
            <div aria-hidden="true" className="fixed inset-0 z-40 bg-navy-950/30 sm:hidden" onClick={() => closeList(false)} />
            <div className="fixed inset-x-0 top-16 bottom-0 z-50 flex flex-col rounded-t-3xl border border-ivory-300 bg-ivory-50 shadow-xl sm:absolute sm:inset-x-auto sm:top-full sm:bottom-auto sm:left-0 sm:z-30 sm:mt-2 sm:max-h-80 sm:w-80 sm:rounded-2xl">
              <div className="flex items-center justify-between px-5 pt-4 sm:hidden">
                <p className="font-display text-lg text-navy-950">Choose your country</p>
                <button
                  type="button"
                  onClick={() => closeList(true)}
                  className="rounded-full px-3 py-1 text-sm font-medium text-sky-600 hover:bg-sky-50"
                >
                  Close
                </button>
              </div>
              <div className="border-b border-ivory-300 p-3">
                <input
                  ref={searchRef}
                  id={ids.search}
                  type="text"
                  role="combobox"
                  aria-expanded="true"
                  aria-controls={ids.list}
                  aria-autocomplete="list"
                  aria-activedescendant={active ? optionId(active.code) : undefined}
                  aria-label="Search countries by name or code"
                  autoComplete="off"
                  spellCheck={false}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveIndex(0);
                  }}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search country or code, e.g. +49"
                  className="h-10 w-full rounded-xl border border-ivory-400 bg-ivory-100 px-3 text-base text-navy-900 outline-none placeholder:text-navy-300 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 sm:text-sm"
                />
              </div>
              <ul
                id={ids.list}
                role="listbox"
                aria-label="Countries"
                className="flex-1 overflow-y-auto overscroll-contain p-1.5"
              >
                {results.map((entry, index) => {
                  const isSelected = entry.code === country;
                  return (
                    <li
                      key={entry.code}
                      id={optionId(entry.code)}
                      role="option"
                      aria-selected={isSelected}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => choose(entry.code)}
                      onMouseMove={() => setActiveIndex(index)}
                      className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm sm:py-2 ${
                        index === activeIndex ? "bg-ivory-200" : ""
                      } ${isSelected ? "font-medium text-sky-700" : "text-navy-900"}`}
                    >
                      <CountryFlag code={entry.code} flags={flags} />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <span className={isSelected ? "text-sky-700" : "text-navy-500"}>+{entry.callingCode}</span>
                      <span aria-hidden="true" className={`w-4 text-sky-600 ${isSelected ? "" : "invisible"}`}>
                        ✓
                      </span>
                    </li>
                  );
                })}
              </ul>
              {results.length === 0 ? (
                <p className="px-5 pb-5 text-sm text-navy-500">No country matches &ldquo;{query}&rdquo;.</p>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      <input type="hidden" name={countryName} value={country} />
      {message ? (
        <p id={ids.message} className={`text-sm ${error ? "text-red-600" : "text-navy-500"}`}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
