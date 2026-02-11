# UI Components Guide

## shadcn/ui Components Installed

Your website now uses **shadcn/ui**, a modern, customizable component library built on Radix UI and Tailwind CSS. This provides a uniform, professional design system throughout your application.

### Installed Components

- **Button** - Styled buttons with multiple variants
- **Card** - Container components for content sections
- **Badge** - Status indicators and labels
- **Table** - Data tables with consistent styling
- **Tabs** - Tab navigation components
- **Dialog** - Modal dialogs
- **Select** - Dropdown select inputs
- **Dropdown Menu** - Context menus
- **Tooltip** - Hover tooltips
- **Chart** - Chart components (works with Recharts)

### Key Features

✅ **Uniform Design** - All components follow the same design system
✅ **Fully Customizable** - Built on Tailwind CSS, easy to customize
✅ **Accessible** - Built on Radix UI primitives (WCAG compliant)
✅ **Type-Safe** - Full TypeScript support
✅ **Dark Mode Ready** - Built-in dark mode support (can be enabled)

## Usage Examples

### Button

```tsx
import { Button } from '@/components/ui/button';

<Button>Default Button</Button>
<Button variant="outline">Outline Button</Button>
<Button variant="destructive">Delete</Button>
<Button variant="secondary">Secondary</Button>
<Button variant="ghost">Ghost Button</Button>
<Button size="sm">Small</Button>
<Button size="lg">Large</Button>
```

### Card

```tsx
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';

<Card>
  <CardHeader>
    <CardTitle>Card Title</CardTitle>
    <CardDescription>Card description text</CardDescription>
  </CardHeader>
  <CardContent>
    {/* Your content here */}
  </CardContent>
</Card>
```

### Badge

```tsx
import { Badge } from '@/components/ui/badge';

<Badge>Default</Badge>
<Badge variant="secondary">Secondary</Badge>
<Badge variant="destructive">Error</Badge>
<Badge variant="outline">Outline</Badge>
```

### Table

```tsx
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Name</TableHead>
      <TableHead>Status</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>John Doe</TableCell>
      <TableCell>Active</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

### Tabs

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

<Tabs defaultValue="overview">
  <TabsList>
    <TabsTrigger value="overview">Overview</TabsTrigger>
    <TabsTrigger value="details">Details</TabsTrigger>
  </TabsList>
  <TabsContent value="overview">Overview content</TabsContent>
  <TabsContent value="details">Details content</TabsContent>
</Tabs>
```

## Charts with Recharts

You already have Recharts installed. The Chart component from shadcn/ui provides styled wrappers:

```tsx
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';

<ChartContainer config={chartConfig}>
  <BarChart data={data}>
    <CartesianGrid strokeDasharray="3 3" />
    <XAxis dataKey="name" />
    <YAxis />
    <ChartTooltip content={<ChartTooltipContent />} />
    <Bar dataKey="value" fill="hsl(var(--chart-1))" />
  </BarChart>
</ChartContainer>
```

## Customization

All components use CSS variables defined in `app/globals.css`. You can customize colors by modifying the `:root` variables:

- `--primary` - Primary brand color
- `--secondary` - Secondary color
- `--muted` - Muted backgrounds
- `--accent` - Accent color
- `--destructive` - Error/destructive actions
- `--border` - Border colors
- `--radius` - Border radius

## Icons

The components use **Lucide React** icons. Install more icons as needed:

```bash
npm install lucide-react
```

Example:
```tsx
import { TrendingUp, DollarSign, Clock } from 'lucide-react';

<TrendingUp className="h-4 w-4" />
```

## Next Steps

1. Gradually migrate existing components to use shadcn/ui components
2. Use the Card component for dashboard stats and sections
3. Replace custom buttons with the Button component
4. Use Badge for status indicators
5. Use Table for all data tables
6. Add charts using the Chart component wrapper

## Documentation

- Full component docs: https://ui.shadcn.com/docs/components
- Radix UI docs: https://www.radix-ui.com/
- Lucide icons: https://lucide.dev/icons/



