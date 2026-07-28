// Gallery page for Playwright component testing (stories & galleries model,
// Playwright v1.62+). Implements the window.mount/window.unmount contract;
// stories are discovered from src/**/*.story.tsx via import.meta.glob.
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type StoryModule = Record<string, (props?: Record<string, unknown>) => unknown>;

const modules = import.meta.glob('/src/**/*.story.tsx', {
  eager: true,
}) as Record<string, StoryModule>;

let root: Root | null = null;

function resolveStory(story: string) {
  const slash = story.lastIndexOf('/');
  if (slash === -1) throw new Error(`invalid story id: ${story}`);
  const filePath = `/src/${story.slice(0, slash)}.story.tsx`;
  const exportName = story.slice(slash + 1);
  const mod = modules[filePath];
  const component = mod?.[exportName];
  if (!component) throw new Error(`unknown story: ${story} (${filePath})`);
  return component;
}

declare global {
  interface Window {
    mount(options: {
      story: string;
      props?: Record<string, unknown>;
    }): Promise<void>;
    unmount(): Promise<void>;
  }
}

window.mount = async ({ story, props }) => {
  const component = resolveStory(story);
  if (!root) root = createRoot(document.getElementById('root')!);
  root.render(createElement(component as never, props));
  // Two frames so React has committed and painted before mount() resolves.
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
};

window.unmount = async () => {
  root?.unmount();
  root = null;
};
