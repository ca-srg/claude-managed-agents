import { tokens } from "./src/features/dashboard/styles/tokens";

export default {
  content: ["./src/features/dashboard/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: tokens.colors,
      spacing: tokens.spacing,
      borderRadius: tokens.radius,
      fontFamily: tokens.font,
      boxShadow: tokens.shadow,
    },
  },
  plugins: [],
};
