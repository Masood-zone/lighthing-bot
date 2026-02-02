import { IconDashboardFilled, type Icon } from "@tabler/icons-react";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Link, matchPath, useLocation } from "react-router-dom";

export function NavMain({
  items,
}: {
  items: {
    title: string;
    url: string;
    icon?: Icon;
  }[];
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const { pathname } = useLocation();
  const isDashboardActive = !!matchPath(
    { path: "/admin", end: true },
    pathname,
  );

  const isPathActive = (targetPath: string) => {
    return !!matchPath({ path: targetPath, end: false }, pathname);
  };

  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  const activeButtonClasses =
    "cursor-pointer data-[active=true]:bg-primary data-[active=true]:text-primary-foreground data-[active=true]:hover:bg-primary/90 data-[active=true]:hover:text-primary-foreground data-[active=true]:active:bg-primary/90 data-[active=true]:active:text-primary-foreground";

  return (
    <SidebarGroup>
      <SidebarGroupContent className="flex flex-col gap-2">
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-2">
            <SidebarMenuButton
              tooltip="Dashboard"
              asChild
              isActive={isDashboardActive}
              className={activeButtonClasses}
            >
              <Link to="/admin" onClick={closeMobileSidebar}>
                <IconDashboardFilled />
                <span>Dashboard</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                tooltip={item.title}
                asChild
                isActive={isPathActive(item.url)}
                className={activeButtonClasses}
              >
                <Link to={item.url} onClick={closeMobileSidebar}>
                  {item.icon && <item.icon />}
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
