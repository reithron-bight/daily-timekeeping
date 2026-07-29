import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  return {
    name: "Daily Timekeeping",
    short_name: "Timekeeping",
    description:
      "A lightweight, private daily timer that creates Excel-ready time sheet rows.",
    start_url: `${basePath}/`,
    display: "standalone",
    background_color: "#f3f2ed",
    theme_color: "#2f6f45",
    icons: [
      {
        src: `${basePath}/icon-192.png`,
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: `${basePath}/icon-512.png`,
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
