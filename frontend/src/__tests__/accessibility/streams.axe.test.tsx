import React from "react";
import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import StreamsPage from "@/app/streams/page";

expect.extend(toHaveNoViolations);

jest.mock("next/link", () => {
  const MockLink = ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>{children}</a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

describe("Accessibility audit — /streams", () => {
  it("renders the page header with a single h1", () => {
    render(<StreamsPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Vested Token Streams" }),
    ).toBeInTheDocument();
  });

  it("coming-soon placeholder has no axe violations", async () => {
    const { container } = render(<StreamsPage />);
    expect(screen.getByRole("heading", { level: 2, name: "Stream List Coming Soon" })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("quick-access section with example stream link has no axe violations", async () => {
    const { container } = render(<StreamsPage />);
    expect(screen.getByRole("link", { name: "View Example Stream" })).toHaveAttribute(
      "href",
      "/streams/example-stream-123",
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
