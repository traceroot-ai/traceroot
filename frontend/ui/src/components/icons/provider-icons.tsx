"use client";

import { FC } from "react";
import { cn } from "@/lib/utils";

interface IconProps {
  className?: string;
}

// OpenAI spiral
export const OpenAIIcon: FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={cn("h-4 w-4", className)}
    xmlns="http://www.w3.org/2000/svg"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);

// Anthropic "A" mark (from lmnr reference)
export const AnthropicIcon: FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={cn("h-4 w-4", className)}
    xmlns="http://www.w3.org/2000/svg"
    fill="currentColor"
    fillRule="evenodd"
    aria-hidden="true"
  >
    <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z" />
  </svg>
);

// Azure (multi-gradient, from lmnr reference)
export const AzureIcon: FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={cn("h-4 w-4", className)}
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      d="M7.242 1.613A1.11 1.11 0 018.295.857h6.977L8.03 22.316a1.11 1.11 0 01-1.052.755h-5.43a1.11 1.11 0 01-1.053-1.466L7.242 1.613z"
      fill="url(#azure-fill-0)"
    />
    <path
      d="M18.397 15.296H7.4a.51.51 0 00-.347.882l7.066 6.595c.206.192.477.298.758.298h6.226l-2.706-7.775z"
      fill="#0078D4"
    />
    <path
      d="M15.272.857H7.497L0 23.071h7.775l1.596-4.73 5.068 4.73h6.665l-2.707-7.775h-7.998L15.272.857z"
      fill="url(#azure-fill-1)"
    />
    <path
      d="M17.193 1.613a1.11 1.11 0 00-1.052-.756h-7.81.035c.477 0 .9.304 1.052.756l6.748 19.992a1.11 1.11 0 01-1.052 1.466h-.12 7.895a1.11 1.11 0 001.052-1.466L17.193 1.613z"
      fill="url(#azure-fill-2)"
    />
    <defs>
      <linearGradient
        gradientUnits="userSpaceOnUse"
        id="azure-fill-0"
        x1="8.247"
        x2="1.002"
        y1="1.626"
        y2="23.03"
      >
        <stop stopColor="#114A8B" />
        <stop offset="1" stopColor="#0669BC" />
      </linearGradient>
      <linearGradient
        gradientUnits="userSpaceOnUse"
        id="azure-fill-1"
        x1="14.042"
        x2="12.324"
        y1="15.302"
        y2="15.888"
      >
        <stop stopOpacity=".3" />
        <stop offset=".071" stopOpacity=".2" />
        <stop offset=".321" stopOpacity=".1" />
        <stop offset=".623" stopOpacity=".05" />
        <stop offset="1" stopOpacity="0" />
      </linearGradient>
      <linearGradient
        gradientUnits="userSpaceOnUse"
        id="azure-fill-2"
        x1="12.841"
        x2="20.793"
        y1="1.626"
        y2="22.814"
      >
        <stop stopColor="#3CCBF4" />
        <stop offset="1" stopColor="#2892DF" />
      </linearGradient>
    </defs>
  </svg>
);

// Google Gemini (gradient gem, from lmnr reference)
export const GoogleIcon: FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={cn("h-4 w-4", className)}
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="gemini-gradient" x1="0%" x2="68.73%" y1="100%" y2="30.395%">
        <stop offset="0%" stopColor="#1C7DFF" />
        <stop offset="52.021%" stopColor="#1C69FF" />
        <stop offset="100%" stopColor="#F0DCD6" />
      </linearGradient>
    </defs>
    <path
      d="M12 24A14.304 14.304 0 000 12 14.304 14.304 0 0012 0a14.305 14.305 0 0012 12 14.305 14.305 0 00-12 12"
      fill="url(#gemini-gradient)"
      fillRule="nonzero"
    />
  </svg>
);

// AWS Bedrock (gradient, from lmnr reference)
export const AWSIcon: FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={cn("h-4 w-4", className)}
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="bedrock-gradient" x1="80%" x2="20%" y1="20%" y2="80%">
        <stop offset="0%" stopColor="#6350FB" />
        <stop offset="50%" stopColor="#3D8FFF" />
        <stop offset="100%" stopColor="#9AD8F8" />
      </linearGradient>
    </defs>
    <path
      d="M13.05 15.513h3.08c.214 0 .389.177.389.394v1.82a1.704 1.704 0 011.296 1.661c0 .943-.755 1.708-1.685 1.708-.931 0-1.686-.765-1.686-1.708 0-.807.554-1.484 1.297-1.662v-1.425h-2.69v4.663a.395.395 0 01-.188.338l-2.69 1.641a.385.385 0 01-.405-.002l-4.926-3.086a.395.395 0 01-.185-.336V16.3L2.196 14.87A.395.395 0 012 14.555L2 14.528V9.406c0-.14.073-.27.192-.34l2.465-1.462V4.448c0-.129.062-.249.165-.322l.021-.014L9.77 1.058a.385.385 0 01.407 0l2.69 1.675a.395.395 0 01.185.336V7.6h3.856V5.683a1.704 1.704 0 01-1.296-1.662c0-.943.755-1.708 1.685-1.708.931 0 1.685.765 1.685 1.708 0 .807-.553 1.484-1.296 1.662v2.311a.391.391 0 01-.389.394h-4.245v1.806h6.624a1.69 1.69 0 011.64-1.313c.93 0 1.685.764 1.685 1.707 0 .943-.754 1.708-1.685 1.708a1.69 1.69 0 01-1.64-1.314H13.05v1.937h4.953l.915 1.18a1.66 1.66 0 01.84-.227c.931 0 1.685.764 1.685 1.707 0 .943-.754 1.708-1.685 1.708-.93 0-1.685-.765-1.685-1.708 0-.346.102-.668.276-.937l-.724-.935H13.05v1.806zM9.973 1.856L7.93 3.122V6.09h-.778V3.604L5.435 4.669v2.945l2.11 1.36L9.712 7.61V5.334h.778V7.83c0 .136-.07.263-.184.335L7.963 9.638v2.081l1.422 1.009-.446.646-1.406-.998-1.53 1.005-.423-.66 1.605-1.055v-1.99L5.038 8.29l-2.26 1.34v1.676l1.972-1.189.398.677-2.37 1.429V14.3l2.166 1.258 2.27-1.368.397.677-2.176 1.311V19.3l1.876 1.175 2.365-1.426.398.678-2.017 1.216 1.918 1.201 2.298-1.403v-5.78l-4.758 2.893-.4-.675 5.158-3.136V3.289L9.972 1.856zM16.13 18.47a.913.913 0 00-.908.92c0 .507.406.918.908.918a.913.913 0 00.907-.919.913.913 0 00-.907-.92zm3.63-3.81a.913.913 0 00-.908.92c0 .508.406.92.907.92a.913.913 0 00.908-.92.913.913 0 00-.908-.92zm1.555-4.99a.913.913 0 00-.908.92c0 .507.407.918.908.918a.913.913 0 00.907-.919.913.913 0 00-.907-.92zM17.296 3.1a.913.913 0 00-.907.92c0 .508.406.92.907.92a.913.913 0 00.908-.92.913.913 0 00-.908-.92z"
      fill="url(#bedrock-gradient)"
      fillRule="nonzero"
    />
  </svg>
);

// DeepSeek
export const DeepSeekIcon: FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={cn("h-4 w-4", className)}
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="12" fill="#4D6BFE" />
    <text
      x="12"
      y="16.5"
      textAnchor="middle"
      fontSize="13"
      fontWeight="bold"
      fill="white"
      fontFamily="sans-serif"
    >
      D
    </text>
  </svg>
);

// OpenRouter
export const OpenRouterIcon: FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={cn("h-4 w-4", className)}
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="12" fill="#6366F1" />
    <text
      x="12"
      y="16.5"
      textAnchor="middle"
      fontSize="13"
      fontWeight="bold"
      fill="white"
      fontFamily="sans-serif"
    >
      O
    </text>
  </svg>
);

// xAI
export const XAIIcon: FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={cn("h-4 w-4", className)}
    xmlns="http://www.w3.org/2000/svg"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M2 2l8.5 10L2 22h2l7.5-9L19 22h3L13.5 12 22 2h-2l-7.5 9L5 2H2z" />
  </svg>
);

// Moonshot (Kimi) - crescent moon
export const MoonshotIcon: FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={cn("h-4 w-4", className)}
    xmlns="http://www.w3.org/2000/svg"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 0 1-5.7-2.3A8 8 0 0 0 12 4a8 8 0 0 1 0 16z" />
  </svg>
);

// Z.AI (GLM)
export const ZAIIcon: FC<IconProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={cn("h-4 w-4", className)}
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="12" fill="#2563EB" />
    <text
      x="12"
      y="16.5"
      textAnchor="middle"
      fontSize="13"
      fontWeight="bold"
      fill="white"
      fontFamily="sans-serif"
    >
      Z
    </text>
  </svg>
);

const PROVIDER_ICONS: Record<string, FC<IconProps>> = {
  openai: OpenAIIcon,
  anthropic: AnthropicIcon,
  azure: AzureIcon,
  google: GoogleIcon,
  "amazon-bedrock": AWSIcon,
  deepseek: DeepSeekIcon,
  openrouter: OpenRouterIcon,
  xai: XAIIcon,
  moonshot: MoonshotIcon,
  zai: ZAIIcon,
};

interface ProviderIconProps {
  adapter: string;
  className?: string;
}

export function ProviderIcon({ adapter, className }: ProviderIconProps) {
  const Icon = PROVIDER_ICONS[adapter.toLowerCase()];

  if (Icon) {
    return <Icon className={className} />;
  }

  // Fallback: gray circle with first letter of adapter
  const letter = adapter.charAt(0).toUpperCase();
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-4 w-4", className)}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="12" fill="#9CA3AF" />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="13"
        fontWeight="bold"
        fill="white"
        fontFamily="sans-serif"
      >
        {letter}
      </text>
    </svg>
  );
}
