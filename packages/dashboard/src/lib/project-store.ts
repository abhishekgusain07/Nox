import { create } from "zustand";
import { persist } from "zustand/middleware";
import { setApiKey } from "./api";

interface Project {
  id: string;
  name: string;
  slug: string;
}

interface ProjectState {
  currentProject: Project | null;
  currentApiKey: string | null;
  setCurrentProject: (project: Project, apiKey: string) => void;
  clear: () => void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      currentProject: null,
      currentApiKey: null,
      setCurrentProject: (project: Project, apiKey: string) => {
        setApiKey(apiKey);
        set({ currentProject: project, currentApiKey: apiKey });
      },
      clear: () => {
        setApiKey(null);
        set({ currentProject: null, currentApiKey: null });
      },
    }),
    {
      name: "reload-project",
      partialize: (state) => ({
        currentProject: state.currentProject,
        currentApiKey: state.currentApiKey,
      }),
    },
  ),
);
