import { Router, Route } from "@solidjs/router";
import Layout from "./components/Layout";
import Products from "./pages/Products";
import ProductDetail from "./pages/ProductDetail";
import Competitors from "./pages/Competitors";
import Settings from "./pages/Settings";

export default function App() {
  return (
    <Router root={Layout}>
      <Route path="/" component={Products} />
      <Route path="/product/:id" component={ProductDetail} />
      <Route path="/competitors" component={Competitors} />
      <Route path="/settings" component={Settings} />
    </Router>
  );
}
