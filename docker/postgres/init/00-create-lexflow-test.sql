-- 仅在数据卷首次初始化时执行（docker-entrypoint-initdb.d）。
-- 供测试会话使用的独立库，与开发库 lexflow 隔离。
CREATE DATABASE lexflow_test;
