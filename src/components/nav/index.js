import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import './styles.css';

const Nav = () => {
    const location = useLocation();
    const navItems = [
        { name: 'Home', path: '/' },
        { name: 'About', path: '/about' },
        { name: 'Contact', path: '/contact' },
        { name: 'Foo', path: '/foo' },
        { name: 'Bar', path: '/bar' },
        { name: 'Comments', path: '/comments' },
    ];

    return (
        <nav className="nav">
            <ul className="nav-list">
                {navItems.map((item) => (
                    <li key={item.path} className={`nav-item ${location.pathname === item.path ? 'active' : ''}`}>
                        <Link to={item.path}>{item.name}</Link>
                    </li>
                ))}
            </ul>
        </nav>
    );
};

export default Nav;
