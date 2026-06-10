import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import "./index.css";
import { Home } from "./pages/Home";
import { Editor } from "./pages/Editor";

const rootRoute = createRootRoute({ component: Outlet });

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
});

const editorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/d/$docId",
  component: Editor,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, editorRoute]),
  defaultNotFoundComponent: () => (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-zinc-50 font-sans text-zinc-500">
      <p>This page doesn't exist.</p>
      <Link to="/" className="font-semibold text-sky-600 hover:text-sky-700">
        Back to your files
      </Link>
    </div>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
