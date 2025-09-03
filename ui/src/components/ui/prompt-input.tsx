'use client';

import { Button } from './button';
import { cn } from '../../lib/utils';
import { Loader2Icon, SendIcon } from 'lucide-react';
import type {
  ComponentProps,
  HTMLAttributes,
} from 'react';
import React, { forwardRef, useRef, useEffect } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';

// Status type for the submit button
export type PromptInputStatus = 'submitted' | 'streaming' | 'ready' | 'error';

// Main form container
export type PromptInputProps = HTMLAttributes<HTMLFormElement>;

export const PromptInput = forwardRef<HTMLFormElement, PromptInputProps>(
  ({ className, ...props }, ref) => (
    <form
      ref={ref}
      className={cn(
        'w-full divide-y rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-800 shadow-sm',
        className
      )}
      {...props}
    />
  )
);
PromptInput.displayName = 'PromptInput';

// Auto-resizing textarea
export interface PromptInputTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  autoResize?: boolean;
  minRows?: number;
  maxRows?: number;
}

export const PromptInputTextarea = forwardRef<HTMLTextAreaElement, PromptInputTextareaProps>(
  ({ className, autoResize = true, minRows = 1, maxRows = 5, onInput, ...props }, ref) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const combinedRef = (node: HTMLTextAreaElement) => {
      textareaRef.current = node;
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    };

    const adjustHeight = () => {
      if (!autoResize || !textareaRef.current) return;

      const textarea = textareaRef.current;
      textarea.style.height = 'auto';

      const lineHeight = parseInt(window.getComputedStyle(textarea).lineHeight);
      const minHeight = lineHeight * minRows;
      const maxHeight = lineHeight * maxRows;

      const newHeight = Math.min(
        Math.max(textarea.scrollHeight, minHeight),
        maxHeight
      );

      textarea.style.height = `${newHeight}px`;

      // Show scrollbar only when content exceeds maxHeight
      if (textarea.scrollHeight > maxHeight) {
        textarea.style.overflowY = 'auto';
      } else {
        textarea.style.overflowY = 'hidden';
      }
    };

    useEffect(() => {
      adjustHeight();
    }, [props.value]);

    const handleInput: React.FormEventHandler<HTMLTextAreaElement> = (e) => {
      adjustHeight();
      onInput?.(e);
    };

    return (
      <textarea
        ref={combinedRef}
        className={cn(
          'w-full resize-none bg-white dark:bg-zinc-700 px-4 py-2 text-sm leading-relaxed placeholder:text-gray-400 dark:placeholder:text-gray-500 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 overflow-y-hidden border-0',
          className
        )}
        onInput={handleInput}
        rows={minRows}
        {...props}
      />
    );
  }
);
PromptInputTextarea.displayName = 'PromptInputTextarea';

// Toolbar container
export interface PromptInputToolbarProps extends HTMLAttributes<HTMLDivElement> {}

export const PromptInputToolbar = forwardRef<HTMLDivElement, PromptInputToolbarProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex items-center justify-between gap-2 px-4 py-3',
        className
      )}
      {...props}
    />
  )
);
PromptInputToolbar.displayName = 'PromptInputToolbar';

// Tools container (left side of toolbar)
export interface PromptInputToolsProps extends HTMLAttributes<HTMLDivElement> {}

export const PromptInputTools = forwardRef<HTMLDivElement, PromptInputToolsProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex items-center gap-3', className)}
      {...props}
    />
  )
);
PromptInputTools.displayName = 'PromptInputTools';

// Generic button for tools
export interface PromptInputButtonProps extends ComponentProps<typeof Button> {}

export const PromptInputButton = forwardRef<HTMLButtonElement, PromptInputButtonProps>(
  ({ className, variant = 'ghost', size = 'sm', ...props }, ref) => (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      className={cn('gap-2 bg-zinc-50 dark:bg-zinc-900', className)}
      {...props}
    />
  )
);
PromptInputButton.displayName = 'PromptInputButton';

// Model Select Components
export interface PromptInputModelSelectProps extends HTMLAttributes<HTMLDivElement> {
  value?: string;
  onValueChange?: (value: string) => void;
}

export const PromptInputModelSelect = forwardRef<HTMLDivElement, PromptInputModelSelectProps>(
  ({ children }, ref) => (
    <DropdownMenu>
      <div ref={ref}>
        {children}
      </div>
    </DropdownMenu>
  )
);
PromptInputModelSelect.displayName = 'PromptInputModelSelect';

export interface PromptInputModelSelectTriggerProps extends ComponentProps<typeof Button> {}

export const PromptInputModelSelectTrigger = forwardRef<HTMLButtonElement, PromptInputModelSelectTriggerProps>(
  ({ className, ...props }, ref) => (
    <DropdownMenuTrigger asChild>
      <Button
        ref={ref}
        variant="ghost"
        size="sm"
        className={cn('gap-2 bg-zinc-50 dark:bg-zinc-900', className)}
        {...props}
      />
    </DropdownMenuTrigger>
  )
);
PromptInputModelSelectTrigger.displayName = 'PromptInputModelSelectTrigger';

export interface PromptInputModelSelectValueProps extends HTMLAttributes<HTMLSpanElement> {}

export const PromptInputModelSelectValue = forwardRef<HTMLSpanElement, PromptInputModelSelectValueProps>(
  ({ className, children, ...props }, ref) => (
    <span ref={ref} className={cn('text-xs', className)} {...props}>
      {children}
    </span>
  )
);
PromptInputModelSelectValue.displayName = 'PromptInputModelSelectValue';

export interface PromptInputModelSelectContentProps extends HTMLAttributes<HTMLDivElement> {}

export const PromptInputModelSelectContent = forwardRef<HTMLDivElement, PromptInputModelSelectContentProps>(
  ({ className, ...props }, ref) => (
    <DropdownMenuContent
      ref={ref}
      side="top"
      align="start"
      className={className}
      {...props}
    />
  )
);
PromptInputModelSelectContent.displayName = 'PromptInputModelSelectContent';

export interface PromptInputModelSelectItemProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  value: string;
  onSelect?: (value: string) => void;
}

export const PromptInputModelSelectItem = forwardRef<HTMLDivElement, PromptInputModelSelectItemProps>(
  ({ className, value, onSelect, ...props }, ref) => (
    <DropdownMenuItem
      ref={ref}
      className={className}
      onSelect={() => onSelect?.(value)}
      {...props}
    />
  )
);
PromptInputModelSelectItem.displayName = 'PromptInputModelSelectItem';

// Submit button with status support
export interface PromptInputSubmitProps extends ComponentProps<typeof Button> {
  status?: PromptInputStatus;
}

export const PromptInputSubmit = forwardRef<HTMLButtonElement, PromptInputSubmitProps>(
  ({ className, status = 'ready', disabled, children, ...props }, ref) => {
    const isLoading = status === 'submitted' || status === 'streaming';

    return (
      <Button
        ref={ref}
        type="submit"
        size="icon"
        className={cn('size-8 shrink-0', className)}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : children ? (
          children
        ) : (
          <SendIcon className="size-4" />
        )}
      </Button>
    );
  }
);
PromptInputSubmit.displayName = 'PromptInputSubmit';
