export const tokens = {
  colors: {
    brand: {
      50: "#0c2622",
      100: "#0f3530",
      200: "#155148",
      300: "#1d7466",
      400: "#27a08e",
      500: "#2dd4bf",
      600: "#14b8a6",
      700: "#0d9488",
      800: "#0f766e",
      900: "#115e59",
      950: "#042f2e",
    },
    neutral: {
      50: "#1a2336",
      100: "#1d273a",
      200: "#27324a",
      300: "#3a4760",
      400: "#7d8aa3",
      500: "#a4b0c7",
      600: "#b9c3d6",
      700: "#d2dae6",
      800: "#e6ebf3",
      900: "#f3f6fb",
      950: "#02060d",
    },
    info: {
      50: "#0f1f3a",
      100: "#16284a",
      200: "#1f386a",
      300: "#2d4f8f",
      400: "#3f72bf",
      500: "#5b96f0",
      600: "#6aa6ff",
      700: "#7fb1ff",
      800: "#a5c8ff",
      900: "#cfe2ff",
      950: "#eaf2ff",
    },
    success: {
      50: "#0d2a1d",
      100: "#0f3a26",
      200: "#155b34",
      300: "#1f7a47",
      400: "#32a35f",
      500: "#4ade80",
      600: "#6ee7a2",
      700: "#86efac",
      800: "#bbf7d0",
      900: "#dcfce7",
      950: "#f0fdf4",
    },
    warning: {
      50: "#2a1f08",
      100: "#3a2a0c",
      200: "#5b3f10",
      300: "#7c5818",
      400: "#a5761d",
      500: "#d6a020",
      600: "#fbbf24",
      700: "#fcd34d",
      800: "#fde68a",
      900: "#fef3c7",
      950: "#fffbeb",
    },
    danger: {
      50: "#2a1015",
      100: "#3a141b",
      200: "#5b1d24",
      300: "#7f2d35",
      400: "#b5444c",
      500: "#ef4444",
      600: "#f87171",
      700: "#fca5a5",
      800: "#fecaca",
      900: "#fee2e2",
      950: "#fef2f2",
    },
    surface: {
      DEFAULT: "#131a26",
      muted: "#0b1220",
      inverse: "#f8fafc",
    },
    status: {
      queued: {
        bg: "#1d273a",
        fg: "#d2dae6",
        border: "#3a4760",
      },
      running: {
        bg: "#0f1f3a",
        fg: "#a5c8ff",
        border: "#1d3a6e",
      },
      completed: {
        bg: "#0d2a1d",
        fg: "#86efac",
        border: "#155b34",
      },
      failed: {
        bg: "#2a1015",
        fg: "#fca5a5",
        border: "#5b1d24",
      },
      aborted: {
        bg: "#2a1f08",
        fg: "#fcd34d",
        border: "#5b3f10",
      },
    },
  },
  spacing: {
    "1": "0.25rem", // 4px
    "2": "0.5rem", // 8px
    "4": "1rem", // 16px
    "6": "1.5rem", // 24px
    "8": "2rem", // 32px
    "12": "3rem", // 48px
    "16": "4rem", // 64px
  },
  radius: {
    sm: "0.125rem", // 2px
    md: "0.375rem", // 6px
    lg: "0.5rem", // 8px
    full: "9999px",
  },
  font: {
    sans: ["DM Sans", "ui-sans-serif", "system-ui", "sans-serif"],
    mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
  },
  shadow: {
    sm: "0 1px 2px 0 rgb(0 0 0 / 0.35)",
    md: "0 4px 8px -2px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.4)",
    lg: "0 12px 24px -6px rgb(0 0 0 / 0.5), 0 4px 8px -4px rgb(0 0 0 / 0.4)",
  },
} as const;
