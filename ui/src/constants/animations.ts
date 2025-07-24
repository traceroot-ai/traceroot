export const fadeInAnimationStyles = `
  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes bounce {
    0%, 20%, 40% {
      transform: scale(0) translateY(0);
    }
    40% {
      transform: scale(1) translateY(-2px);
    }
  }

  .animate-fadeIn {
    animation: fadeIn 0.5s ease-out forwards;
  }

  .loading-dot-1 {
    animation: bounce 1.4s infinite ease-in-out both;
    animation-delay: -0.32s;
  }

  .loading-dot-2 {
    animation: bounce 1.4s infinite ease-in-out both;
    animation-delay: -0.16s;
  }

  .loading-dot-3 {
    animation: bounce 1.4s infinite ease-in-out both;
  }
`;
