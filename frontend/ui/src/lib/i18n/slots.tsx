import { Fragment, type ReactNode } from "react";

/**
 * Renders a message that has an element in the middle of it, such as a bold name:
 * `<Slots text={t("group.key")} slots={{ name: <b>{name}</b> }} />` puts the element where the
 * text says `{name}`. The sentence stays one key, so a translation can move the placeholder.
 */
export function Slots({ text, slots }: { text: string; slots: Record<string, ReactNode> }) {
  return text.split(/(\{\w+\})/).map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return (
      <Fragment key={index}>{name && Object.hasOwn(slots, name) ? slots[name] : part}</Fragment>
    );
  });
}
