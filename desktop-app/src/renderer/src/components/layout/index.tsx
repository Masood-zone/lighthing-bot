import { Logo } from "@/assets";
import { Link, Outlet } from "react-router-dom";
import { Toaster } from "sonner";

function RootLayout() {
  return (
    <>
      {/* Navbar */}
      <Link to="/">
        <header className="p-5 flex items-center hover:cursor-pointer">
          <img src={Logo} alt="Logo" width={40} height={40} />
          <h1 className="md:text-2xl font-bold ml-2 text-lg">Lightning Bot</h1>
        </header>
      </Link>

      <main className="">
        <Outlet />
      </main>
      <Toaster />
    </>
  );
}

export default RootLayout;
