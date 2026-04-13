# AI Development Rules

## Tech Stack

- **React 18+** with **TypeScript** for type-safe component development
- **React Router** for client-side routing (routes defined in `src/App.tsx`)
- **Tailwind CSS** for all styling (use utility classes extensively, avoid custom CSS)
- **shadcn/ui** component library (pre-installed, import and use as-is)
- **Radix UI** primitives (pre-installed as shadcn/ui dependencies)
- **Lucide React** for icons (`lucide-react` package)

## Project Structure

- `src/` - All source code lives here
- `src/pages/` - Page components (one per route)
- `src/components/` - Reusable UI components
- `src/pages/Index.tsx` - Main/default page (always update to showcase new features)
- `src/App.tsx` - Route definitions (keep all routes here)

## Library Usage Rules

- **Styling**: Use Tailwind CSS classes exclusively. No inline styles or CSS modules.
- **UI Components**: Use shadcn/ui components from `src/components/ui/`. Do not modify these files directly; create wrapper components if customization is needed.
- **Icons**: Use Lucide React icons (`import { IconName } from 'lucide-react'`)
- **Forms**: Use shadcn/ui form components with React Hook Form (pre-configured)
- **State Management**: Use React hooks (useState, useContext) for local state. Add external libraries only if explicitly needed.
- **Routing**: Use React Router's `<Link>`, `useNavigate()`, and `useParams()` hooks. Define all routes in `src/App.tsx`.

## Development Guidelines

- Always create fully functional, production-ready code (no TODOs or placeholders)
- Keep components small and focused (single responsibility)
- Use TypeScript types and interfaces for props and data structures
- Verify changes with type checking after edits
- Update the main Index page to display new components so users can see them immediately
- Follow existing code patterns and naming conventions in the project
