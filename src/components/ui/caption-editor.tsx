"use client";

import * as React from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Undo2, Redo2, Smile, Hash } from "lucide-react";
import { Button } from "./primitives";
import { cn } from "@/lib/client/utils";

const EMOJI = ["🔥", "✨", "🎯", "💡", "👇", "✅", "🚀", "😮", "🙌", "📌", "🎬", "💬"];

const toDoc = (text: string) => ({ type: "doc", content: (text || "").split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })) });

/**
 * Caption editor. Platforms accept plain text, so formatting marks are disabled and the editor
 * emits plain text with line breaks preserved. Provides undo/redo, emoji, hashtag insert and a live limit counter.
 */
export function CaptionEditor({ value, onChange, limit, placeholder = "Write a caption…", ariaLabel = "Caption" }: { value: string; onChange: (v: string) => void; limit?: number; placeholder?: string; ariaLabel?: string }) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit.configure({ heading: false, bold: false, italic: false, strike: false, code: false, codeBlock: false, blockquote: false, bulletList: false, orderedList: false, listItem: false, horizontalRule: false }), Placeholder.configure({ placeholder })],
    content: toDoc(value),
    editorProps: { attributes: { "aria-label": ariaLabel, role: "textbox", "aria-multiline": "true", class: "tiptap px-3 py-2 text-sm leading-relaxed min-h-24" } },
    onUpdate: ({ editor }) => onChange(editor.getText({ blockSeparator: "\n" })),
  });
  React.useEffect(() => {
    if (editor && editor.getText({ blockSeparator: "\n" }) !== value) editor.commands.setContent(toDoc(value), { emitUpdate: false });
  }, [value, editor]);
  const len = value.length;
  const tags = (value.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  return (
    <div className="rounded-md border border-line bg-ink-2 focus-within:border-violet">
      <EditorContent editor={editor} />
      <div className="flex items-center gap-1 border-t border-line-soft px-1.5 py-1">
        <Button type="button" size="icon" variant="ghost" className="size-7" aria-label="Undo" onClick={() => editor?.chain().focus().undo().run()}><Undo2 /></Button>
        <Button type="button" size="icon" variant="ghost" className="size-7" aria-label="Redo" onClick={() => editor?.chain().focus().redo().run()}><Redo2 /></Button>
        <details className="relative">
          <summary className="flex size-7 cursor-pointer list-none items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg" aria-label="Insert emoji"><Smile className="size-4" /></summary>
          <div className="absolute bottom-8 left-0 z-20 grid w-48 grid-cols-6 gap-1 rounded-md border border-line bg-raised p-2 shadow-xl">{EMOJI.map((e) => <button type="button" key={e} className="rounded p-1 text-base hover:bg-line" onClick={() => editor?.chain().focus().insertContent(e).run()}>{e}</button>)}</div>
        </details>
        <Button type="button" size="icon" variant="ghost" className="size-7" aria-label="Insert hashtag" onClick={() => editor?.chain().focus().insertContent(" #").run()}><Hash /></Button>
        <span className="ml-auto pr-1.5 text-xs tabular-nums text-faint">{tags} hashtags</span>
        <span className={cn("pr-1.5 text-xs tabular-nums", limit && len > limit ? "text-danger" : "text-faint")}>{len}{limit ? `/${limit}` : ""}</span>
      </div>
    </div>
  );
}
