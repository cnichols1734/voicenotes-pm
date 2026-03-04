/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                primary: "#0A0A14", // Deep Void
                accent: "#7B61FF",  // Plasma
                background: "#F0EFF4", // Ghost
                textDark: "#18181B" // Graphite
            },
            fontFamily: {
                heading: ['Sora', 'sans-serif'],
                drama: ['Instrument Serif', 'serif'],
                data: ['Fira Code', 'monospace'],
                sans: ['Sora', 'sans-serif'], // setting sora as the default body font can also work well, or we can use inter. Assuming Sora.
            },
            borderRadius: {
                '2rem': '2rem',
                '3rem': '3rem',
                '4rem': '4rem',
            }
        },
    },
    plugins: [],
}
